import type { PluginClusterConfig } from "../../types.js";
import {
  type VeSyncClient,
  type VeSyncDeviceInfo,
  VeSyncError,
} from "./vesync-client.js";

export interface VeSyncUnit {
  key: string;
  label: string;
  deviceType: string;
}

export type VeSyncState = Record<string, PluginClusterConfig[]>;

export interface VeSyncFamily {
  id: string;
  label: string;
  units(device: VeSyncDeviceInfo): VeSyncUnit[];
  initial(device: VeSyncDeviceInfo): VeSyncState;
  read(client: VeSyncClient, device: VeSyncDeviceInfo): Promise<VeSyncState>;
  write(
    client: VeSyncClient,
    device: VeSyncDeviceInfo,
    unitKey: string,
    clusterId: string,
    attribute: string,
    value: unknown,
  ): Promise<boolean>;
}

type Data = Record<string, unknown>;
type Setter = (
  client: VeSyncClient,
  device: VeSyncDeviceInfo,
  on: boolean,
  unitKey: string,
) => Promise<unknown>;

const plugUnit = (): VeSyncUnit => ({
  key: "",
  label: "",
  deviceType: "on_off_plugin_unit",
});

const onOff = (on: boolean): PluginClusterConfig[] => [
  { clusterId: "onOff", attributes: { onOff: on } },
];

const switchData = (camel: boolean, on: boolean): Data =>
  camel ? { powerSwitch: on ? 1 : 0, switchIdx: 0 } : { enabled: on, id: 0 };

function onOffWrite(set: Setter, canStart = true): VeSyncFamily["write"] {
  return async (client, device, unitKey, clusterId, attribute, value) => {
    if (clusterId !== "onOff" || attribute !== "onOff") return true;
    if (typeof value !== "boolean") return true;
    if (value && !canStart) return false;
    await set(client, device, value, unitKey);
    return true;
  };
}

function plug(
  id: string,
  label: string,
  read: (client: VeSyncClient, device: VeSyncDeviceInfo) => Promise<boolean>,
  set: Setter,
): VeSyncFamily {
  return {
    id,
    label,
    units: () => [plugUnit()],
    initial: () => ({ "": onOff(false) }),
    read: async (client, device) => ({ "": onOff(await read(client, device)) }),
    write: onOffWrite(set),
  };
}

const setSwitchEnabled: Setter = (client, device, on) =>
  client.bypassV2(device, "setSwitch", switchData(false, on));

const whogPlug = plug(
  "outlet-v2",
  "Smart plug",
  async (client, device) =>
    Boolean((await client.bypassV2(device, "getOutletStatus")).enabled),
  setSwitchEnabled,
);

const esw10Plug = plug(
  "outlet-v2",
  "Smart plug",
  async (client, device) =>
    Boolean((await client.bypassV2(device, "getSwitch", { id: 0 })).enabled),
  setSwitchEnabled,
);

const BSDOG_PROPERTIES = [
  "powerSwitch_1",
  "realTimeVoltage",
  "realTimePower",
  "electricalEnergy",
  "protectionStatus",
  "voltageUpperThreshold",
  "currentUpperThreshold",
  "scheduleNum",
];

const propertyPlug = plug(
  "outlet-prop",
  "Smart plug",
  async (client, device) => {
    const r = await client.bypassV2(device, "getProperty", {
      properties: BSDOG_PROPERTIES,
    });
    return Boolean(r.powerSwitch_1);
  },
  (client, device, on) =>
    client.bypassV2(
      device,
      "setProperty",
      { powerSwitch_1: on ? 1 : 0 },
      { subDevice: true },
    ),
);

// an offline V1 device still answers code 0
const readV1 = async (client: VeSyncClient, device: VeSyncDeviceInfo) => {
  const r = await client.bypassV1(device, "deviceDetail");
  if (r.connectionStatus !== undefined && r.connectionStatus !== "online") {
    throw new VeSyncError("offline", "VeSync deviceDetail: device offline");
  }
  return r.deviceStatus === "on";
};

const v1Outlet = plug("outlet-v1", "Smart plug", readV1, (client, device, on) =>
  client.bypassV1(device, "deviceStatus", { status: on ? "on" : "off" }),
);

const wallSwitch = plug(
  "outlet-v1",
  "Wall switch",
  readV1,
  (client, device, on) =>
    client.bypassV1(device, "deviceStatus", {
      status: on ? "on" : "off",
      switchNo: 0,
    }),
);

// A fryer counts as on unless it is in standby or cookEnd, so ready (armed,
// waiting for the start button) and paused programs can still be ended. On
// writes are refused: EU units reject or only arm a remote start, and a voice
// assistant must not switch on a heating appliance.
const cooking = (status: unknown) =>
  typeof status === "string" &&
  !["standby", "cookend"].includes(status.toLowerCase());

// last multi status per cid, endCook takes sync and whole basket from it
const dualStatus = new Map<string, Data>();

const fryerDual: VeSyncFamily = {
  id: "fryer-dual",
  label: "Air fryer (two baskets)",
  units: () => [
    { key: "left", label: "Left", deviceType: "on_off_plugin_unit" },
    { key: "right", label: "Right", deviceType: "on_off_plugin_unit" },
  ],
  initial: () => ({ left: onOff(false), right: onOff(false) }),
  async read(client, device) {
    const r = await client.bypassV2(
      device,
      "getAirfryerMultiStatus",
      {},
      { subDevice: true },
    );
    dualStatus.set(device.cid, r);
    const list = Array.isArray(r.statusList) ? (r.statusList as Data[]) : [];
    // chamber 3 is the whole basket with the divider removed
    const on = (chamber: number) =>
      list.some(
        (item) =>
          (item.chamber === chamber || item.chamber === 3) &&
          cooking(item.cookStatus),
      );
    return { left: onOff(on(1)), right: onOff(on(2)) };
  },
  write: onOffWrite((client, device, _on, unitKey) => {
    const last = dualStatus.get(device.cid);
    let chamber = unitKey === "right" ? 2 : 1;
    if (last?.workChamber === 3) chamber = 3;
    // synced cook uses chamber 4 for both baskets
    if (last?.syncType === 2) chamber = 4;
    return client.bypassV2(device, "endCook", { chamber }, { subDevice: true });
  }, false),
};

const fryerSingle: VeSyncFamily = {
  id: "fryer-single",
  label: "Air fryer",
  units: () => [plugUnit()],
  initial: () => ({ "": onOff(false) }),
  async read(client, device) {
    const r = await client.bypassV2(
      device,
      "getAirfryerStatus",
      {},
      { subDevice: true },
    );
    return { "": onOff(cooking(r.cookStatus)) };
  },
  write: onOffWrite(
    (client, device) =>
      client.bypassV2(device, "endCook", {}, { subDevice: true }),
    false,
  ),
};

// fanModeSequence 0 has no Auto, so the reported level maps onto Low/Med/High.
// Floor keeps the write side's ceil on the same level.
function fanState(on: boolean, level: number, levels: number) {
  const percent = on ? Math.floor((level * 100) / levels) : 0;
  const fanMode = on ? Math.max(1, Math.ceil((level * 3) / levels)) : 0;
  return [
    {
      clusterId: "fanControl",
      attributes: { fanMode, percentSetting: percent, percentCurrent: percent },
    },
  ];
}

// camel: powerSwitch/fanSpeedLevel, else enabled/level
function fanFamily(
  id: string,
  deviceType: string,
  status: string,
  camel: boolean,
  levels: number,
): VeSyncFamily {
  const powered = new Map<string, boolean>();
  return {
    id,
    label: deviceType === "fan" ? "Fan" : "Air purifier",
    units: () => [{ key: "", label: "", deviceType }],
    initial: () => ({ "": fanState(false, 0, levels) }),
    async read(client, device) {
      const r = await client.bypassV2(device, status);
      const on = Boolean(camel ? r.powerSwitch : r.enabled);
      powered.set(device.cid, on);
      const speed = (value: unknown) => {
        const n = Number(value) || 0;
        return n === 255 ? 0 : Math.min(n, levels);
      };
      // V2 models report 255 in auto and sleep mode, 0 percent would read as
      // off, so a running fan shows its manual or lowest level instead
      const level =
        speed(camel ? r.fanSpeedLevel : r.level) ||
        speed(r.manualSpeedLevel) ||
        1;
      return { "": fanState(on, level, levels) };
    },
    async write(client, device, _unitKey, clusterId, attribute, value) {
      if (clusterId !== "fanControl" || typeof value !== "number") return true;
      const turn = async (on: boolean) => {
        await client.bypassV2(device, "setSwitch", switchData(camel, on));
        powered.set(device.cid, on);
      };
      const ensureOn = async () => {
        if (powered.get(device.cid) !== true) await turn(true);
      };
      const setLevel = async (level: number) => {
        await ensureOn();
        await client.bypassV2(
          device,
          "setLevel",
          camel
            ? { levelIdx: 0, manualSpeedLevel: level, levelType: "wind" }
            : { id: 0, level, type: "wind" },
        );
      };
      if (attribute === "percentSetting") {
        if (value <= 0) await turn(false);
        else await setLevel(Math.ceil((value * levels) / 100));
      } else if (attribute === "fanMode") {
        if (value === 0) await turn(false);
        else if (value === 1 || value === 2 || value === 3)
          await setLevel(Math.floor((value * levels) / 3));
        // 4 is On without a level; just turn on
        else if (value === 4) await ensureOn();
      }
      return true;
    },
  };
}

function humidifier(camel: boolean): VeSyncFamily {
  const state = (on: boolean, humidity: unknown): VeSyncState => ({
    "": onOff(on),
    humidity: [
      {
        clusterId: "relativeHumidityMeasurement",
        attributes: {
          // relativeHumidityMeasurement is hundredths of a percent
          measuredValue:
            typeof humidity === "number" && humidity >= 0 && humidity <= 100
              ? Math.round(humidity * 100)
              : null,
        },
      },
    ],
  });
  return {
    id: "humidifier",
    label: "Humidifier",
    units: () => [
      plugUnit(),
      { key: "humidity", label: "Humidity", deviceType: "humidity_sensor" },
    ],
    initial: () => state(false, null),
    async read(client, device) {
      const r = await client.bypassV2(device, "getHumidifierStatus");
      return state(Boolean(camel ? r.powerSwitch : r.enabled), r.humidity);
    },
    write: onOffWrite((client, device, on) =>
      client.bypassV2(device, "setSwitch", switchData(camel, on)),
    ),
  };
}

const PURIFIER = "getPurifierStatus";
const core3 = fanFamily("purifier-core", "air_purifier", PURIFIER, false, 3);
const core4 = fanFamily("purifier-core", "air_purifier", PURIFIER, false, 4);
const snakeHumidifier = humidifier(false);
const camelHumidifier = humidifier(true);

// pyvesync device_map.py order, which decides the suffix fallback
const MODELS: [string[], VeSyncFamily][] = [
  [["ESW10-USA", "ESW10-EU"], esw10Plug],
  [["ESW01-EU", "ESW01-USA", "ESW03-USA", "ESW03-EU", "ESW15-USA"], v1Outlet],
  [["WHOGPLUG"], whogPlug],
  [
    [
      "BSDOG01",
      "BSDOG02",
      "WYSMTOD16A",
      "WM-PLUG",
      "JXUK13APLUG",
      "WYZYOGMINIPLUG",
      "HWPLUG16A",
      "FY-PLUG",
      "HWPLUG16",
      "WYLDR16A1081",
    ],
    propertyPlug,
  ],
  [["ESWL01", "ESWL03"], wallSwitch],
  [
    ["LTF-F422S-KEU", "LTF-F422S-WUSR", "LTF-F422S-WJP", "LTF-F422S-WUS"],
    fanFamily("fan", "fan", "getTowerFanStatus", true, 12),
  ],
  [
    ["LPF-R432S-AEU", "LPF-R432S-AUS"],
    fanFamily("fan", "fan", "getFanStatus", true, 12),
  ],
  [
    ["Core200S", "LAP-C201S-AUSR", "LAP-C202S-WUSR"],
    fanFamily("purifier-core", "air_purifier", PURIFIER, false, 3),
  ],
  [
    [
      "Core300S",
      "LAP-C301S-WJP",
      "LAP-C302S-WUSB",
      "LAP-C301S-WAAA",
      "LAP-C302S-WGC",
    ],
    core3,
  ],
  [["Core400S", "LAP-C401S-WJP", "LAP-C401S-WUSR", "LAP-C401S-WAAA"], core4],
  [["Core600S", "LAP-C601S-WUS", "LAP-C601S-WUSR", "LAP-C601S-WEU"], core4],
  [["LV-RH131S-WM", "LV-RH131S"], core3],
  [
    [
      "LAP-V102S-AASR",
      "LAP-V102S-WUS",
      "LAP-V102S-WEU",
      "LAP-V102S-AUSR",
      "LAP-V102S-WJP",
      "LAP-V102S-AJPR",
      "LAP-V102S-AEUR",
      "LAP-V201S-AASR",
      "LAP-V201S-WJP",
      "LAP-V201S-WEU",
      "LAP-V201S-WUS",
      "LAP-V201-AUSR",
      "LAP-V201S-AUSR",
      "LAP-V201S-AEUR",
    ],
    fanFamily("purifier-v2", "air_purifier", PURIFIER, true, 4),
  ],
  [
    [
      "LAP-EL551S-AUS",
      "LAP-EL551S-AEUR",
      "LAP-EL551S-WEU",
      "LAP-EL551S-WUS",
      "LAP-B851S-WEU",
      "LAP-B851S-WNA",
      "LAP-B851S-AEUR",
      "LAP-B851S-AUS",
      "LAP-B851S-WUS",
      "LAP-BAY-MAX01S",
    ],
    fanFamily("purifier-v2", "air_purifier", PURIFIER, true, 3),
  ],
  [
    [
      "Classic300S",
      "LUH-A601S-WUSB",
      "LUH-A601S-AUSW",
      "Classic200S",
      "Dual200S",
      "LUH-D301S-WUSR",
      "LUH-D301S-WJP",
      "LUH-D301S-WEU",
      "LUH-D301S-KEUR",
      "LUH-A602S-WUSR",
      "LUH-A602S-WUS",
      "LUH-A602S-WEUR",
      "LUH-A602S-WEU",
      "LUH-A602S-WJP",
      "LUH-A602S-WUSC",
    ],
    snakeHumidifier,
  ],
  [["LUH-A603S-WUS"], camelHumidifier],
  [
    [
      "LUH-O451S-WEU",
      "LUH-O451S-WUS",
      "LUH-O451S-WUSR",
      "LUH-O601S-WUS",
      "LUH-O601S-KUS",
    ],
    snakeHumidifier,
  ],
  [
    [
      "LUH-M101S-WUS",
      "LUH-M101S-WUSR",
      "LUH-M101S-WEUR",
      "LEH-S601S-WUS",
      "LEH-S601S-WUSR",
      "LEH-S601S-WEUR",
      "LEH-S602S-WUS",
      "LEH-B381S-WUS",
      "LEH-B381S-WEU",
    ],
    camelHumidifier,
  ],
];

const FRYERS: [string, VeSyncFamily][] = [
  ["CAF-TF10", fryerDual],
  ["CAF-P583S", fryerSingle],
  ["CAF-DC601S", fryerSingle],
];

export function familyFor(deviceType: string): VeSyncFamily | undefined {
  const upper = deviceType.toUpperCase();
  const fryer = FRYERS.find(([prefix]) => upper.startsWith(prefix));
  if (fryer) return fryer[1];
  const exact = MODELS.find(([types]) => types.includes(deviceType));
  if (exact) return exact[1];
  const parts = deviceType.split("-");
  if (parts.length < 3) return undefined;
  const base = parts.slice(0, -1).join("-").toLowerCase();
  return MODELS.find(([types]) =>
    types.some((t) => t.toLowerCase().includes(base)),
  )?.[1];
}
