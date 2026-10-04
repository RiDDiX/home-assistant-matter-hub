import { describe, expect, it } from "vitest";
import type { VeSyncClient, VeSyncDeviceInfo } from "./vesync-client.js";
import { familyFor, type VeSyncFamily } from "./vesync-devices.js";

interface Call {
  api: "v1" | "v2";
  method: string;
  data?: unknown;
  options?: unknown;
}

function fakeClient(results: Record<string, Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const client = {
    bypassV2: async (
      _device: VeSyncDeviceInfo,
      method: string,
      data?: Record<string, unknown>,
      options?: { subDevice?: boolean },
    ) => {
      calls.push({ api: "v2", method, data, options });
      return results[method] ?? {};
    },
    bypassV1: async (
      _device: VeSyncDeviceInfo,
      endpoint: string,
      extra?: Record<string, unknown>,
    ) => {
      calls.push({ api: "v1", method: endpoint, data: extra });
      return results[endpoint] ?? {};
    },
  } as unknown as VeSyncClient;
  return { client, calls };
}

let nextCid = 0;
function device(deviceType: string): VeSyncDeviceInfo {
  nextCid++;
  return {
    cid: `cid-${nextCid}`,
    name: "Dev",
    deviceType,
    configModule: "module",
    online: true,
  };
}

function family(deviceType: string): VeSyncFamily {
  const f = familyFor(deviceType);
  if (!f) throw new Error(`no family for ${deviceType}`);
  return f;
}

const onOff = (on: boolean) => [
  { clusterId: "onOff", attributes: { onOff: on } },
];
const fan = (fanMode: number, percent: number) => [
  {
    clusterId: "fanControl",
    attributes: { fanMode, percentSetting: percent, percentCurrent: percent },
  },
];

const MODELS: Record<string, string[]> = {
  "fryer-dual": ["CAF-TF101S-AEU", "CAF-TF101S", "CAF-TF102S"],
  "fryer-single": [
    "CAF-DC601S-WUSR",
    "CAF-DC601S-WUS",
    "CAF-P583S-KUS",
    "CAF-P583S-KEU",
  ],
  "outlet-v2": ["WHOGPLUG", "ESW10-USA", "ESW10-EU"],
  "outlet-prop": [
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
  "outlet-v1": [
    "ESW01-EU",
    "ESW01-USA",
    "ESW03-USA",
    "ESW03-EU",
    "ESW15-USA",
    "ESWL01",
    "ESWL03",
  ],
  "purifier-core": [
    "Core200S",
    "LAP-C201S-AUSR",
    "LAP-C202S-WUSR",
    "Core300S",
    "LAP-C301S-WJP",
    "LAP-C302S-WUSB",
    "LAP-C301S-WAAA",
    "LAP-C302S-WGC",
    "Core400S",
    "LAP-C401S-WJP",
    "LAP-C401S-WUSR",
    "LAP-C401S-WAAA",
    "Core600S",
    "LAP-C601S-WUS",
    "LAP-C601S-WUSR",
    "LAP-C601S-WEU",
    "LV-RH131S-WM",
    "LV-RH131S",
  ],
  "purifier-v2": [
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
  fan: [
    "LTF-F422S-KEU",
    "LTF-F422S-WUSR",
    "LTF-F422S-WJP",
    "LTF-F422S-WUS",
    "LPF-R432S-AEU",
    "LPF-R432S-AUS",
  ],
  humidifier: [
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
    "LUH-A603S-WUS",
    "LUH-O451S-WEU",
    "LUH-O451S-WUS",
    "LUH-O451S-WUSR",
    "LUH-O601S-WUS",
    "LUH-O601S-KUS",
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
};

describe("familyFor", () => {
  it("maps every listed model to its family", () => {
    for (const [id, models] of Object.entries(MODELS)) {
      for (const model of models) {
        expect(familyFor(model)?.id, model).toBe(id);
      }
    }
  });

  it("drops an unknown region suffix like pyvesync", () => {
    expect(familyFor("LAP-C401S-WEUR")?.id).toBe("purifier-core");
    expect(familyFor("LAP-V201S-WUK")?.id).toBe("purifier-v2");
    expect(familyFor("LTF-F422S-KUK")?.id).toBe("fan");
    expect(familyFor("LUH-D301S-KUK")?.id).toBe("humidifier");
    expect(familyFor("LEH-S601S-WJP")?.id).toBe("humidifier");
  });

  it("matches fryers by prefix in any spelling", () => {
    expect(familyFor("CAF-TF101S-AEUR")?.id).toBe("fryer-dual");
    expect(familyFor("CAF-TF101S-AUKR")?.id).toBe("fryer-dual");
    expect(familyFor("caf-tf102s")?.id).toBe("fryer-dual");
    expect(familyFor("CAF-P583S-KUK")?.id).toBe("fryer-single");
    expect(familyFor("CAF-DC601S-WEU")?.id).toBe("fryer-single");
  });

  it("leaves unsupported models out", () => {
    for (const model of [
      "LV-PUR131S",
      "ESO15-TB",
      "ESWD16",
      "ESL100MC",
      "XYD0001",
      "wifi-switch-1.3",
      "LTM-A401S-WUS",
      "CS158-AF",
      "CS137-AF/CS158-AF",
      "CTO-R301S-SUSW",
      "CAF-DC111S-AEU",
    ]) {
      expect(familyFor(model), model).toBeUndefined();
    }
  });
});

describe("fryer-dual", () => {
  const f = family("CAF-TF102S");
  // pyvesync-afr call_json_fryers.py CAF-TF101S details, chamber 2 armed
  const cookingLeft = {
    statusList: [
      {
        cookStatus: "cooking",
        chamber: 1,
        cookSetTime: 600,
        cookTemp: 180,
        mode: "AirFry",
        currentRemainingTime: 540,
        totalTimeRemaining: 540,
        startTime: 1767318116,
        recipeType: 3,
        recipeId: 14,
        recipeName: "Air Fry",
        upc: "",
        holdTime: 0,
      },
      { cookStatus: "ready", chamber: 2 },
    ],
    tempUnit: "c",
    syncType: 0,
    workChamber: 1,
  };

  it("has a left and a right basket, both off at first", () => {
    const d = device("CAF-TF102S");
    expect(f.units(d).map((u) => [u.key, u.label, u.deviceType])).toEqual([
      ["left", "Left", "on_off_plugin_unit"],
      ["right", "Right", "on_off_plugin_unit"],
    ]);
    expect(f.initial(d)).toEqual({ left: onOff(false), right: onOff(false) });
  });

  it("reads getAirfryerMultiStatus with the sub device keys", async () => {
    const { client, calls } = fakeClient({
      getAirfryerMultiStatus: cookingLeft,
    });
    expect(await f.read(client, device("CAF-TF102S"))).toEqual({
      left: onOff(true),
      right: onOff(true),
    });
    expect(calls).toEqual([
      {
        api: "v2",
        method: "getAirfryerMultiStatus",
        data: {},
        options: { subDevice: true },
      },
    ]);
  });

  it("counts standby, cookEnd and a missing chamber as off", async () => {
    const { client } = fakeClient({
      getAirfryerMultiStatus: {
        statusList: [{ cookStatus: "CookEnd", chamber: 1 }],
        tempUnit: "c",
        syncType: 0,
        workChamber: 0,
      },
    });
    expect(await f.read(client, device("CAF-TF102S"))).toEqual({
      left: onOff(false),
      right: onOff(false),
    });
  });

  it("never starts a basket", async () => {
    const { client, calls } = fakeClient();
    const d = device("CAF-TF102S");
    expect(await f.write(client, d, "left", "onOff", "onOff", true)).toBe(
      false,
    );
    expect(await f.write(client, d, "right", "onOff", "onOff", true)).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });

  it("ends the written basket", async () => {
    const { client, calls } = fakeClient({
      getAirfryerMultiStatus: cookingLeft,
    });
    const d = device("CAF-TF102S");
    await f.read(client, d);
    calls.length = 0;
    expect(await f.write(client, d, "left", "onOff", "onOff", false)).toBe(
      true,
    );
    expect(await f.write(client, d, "right", "onOff", "onOff", false)).toBe(
      true,
    );
    expect(calls).toEqual([
      {
        api: "v2",
        method: "endCook",
        data: { chamber: 1 },
        options: { subDevice: true },
      },
      {
        api: "v2",
        method: "endCook",
        data: { chamber: 2 },
        options: { subDevice: true },
      },
    ]);
  });

  it("ends a whole basket and a synced cook as the last status says", async () => {
    const whole = fakeClient({
      getAirfryerMultiStatus: {
        statusList: [{ cookStatus: "cooking", chamber: 3 }],
        syncType: 0,
        workChamber: 3,
      },
    });
    const d1 = device("CAF-TF101S");
    expect(await f.read(whole.client, d1)).toEqual({
      left: onOff(true),
      right: onOff(true),
    });
    await f.write(whole.client, d1, "right", "onOff", "onOff", false);
    expect(whole.calls[1]).toMatchObject({
      method: "endCook",
      data: { chamber: 3 },
    });

    const synced = fakeClient({
      getAirfryerMultiStatus: {
        statusList: [
          { cookStatus: "cooking", chamber: 1 },
          { cookStatus: "cooking", chamber: 2 },
        ],
        syncType: 2,
        workChamber: 4,
      },
    });
    const d2 = device("CAF-TF101S");
    await f.read(synced.client, d2);
    await f.write(synced.client, d2, "left", "onOff", "onOff", false);
    expect(synced.calls[1]).toMatchObject({
      method: "endCook",
      data: { chamber: 4 },
    });
  });
});

describe("fryer-single", () => {
  const f = family("CAF-P583S-KUS");
  // getAirfryerStatus answer from the app capture in pyvesync issue 477
  const armed = {
    stepArray: [
      {
        cookSetTime: 1200,
        cookTemp: 385,
        mode: "French fries",
        cookLastTime: 1200,
        shakeTime: 0,
        cookEndTime: 0,
        recipeName: "French Fries",
        recipeId: 6,
        recipeType: 3,
      },
    ],
    stepIndex: 0,
    cookMode: "normal",
    cookStatus: "ready",
    tempUnit: "f",
    preheatSetTime: 0,
    preheatLastTime: 0,
    preheatEndTime: 0,
    preheatTemp: 0,
    startTime: 1765251913,
    totalTimeRemaining: 1200,
    currentTemp: 51,
    appointLastTime: 0,
    shakeStatus: 0,
    linkageStatus: 0,
  };

  it("counts ready as on", async () => {
    const { client, calls } = fakeClient({ getAirfryerStatus: armed });
    expect(await f.read(client, device("CAF-P583S-KUS"))).toEqual({
      "": onOff(true),
    });
    expect(calls).toEqual([
      {
        api: "v2",
        method: "getAirfryerStatus",
        data: {},
        options: { subDevice: true },
      },
    ]);
  });

  it("counts standby and cookEnd as off", async () => {
    for (const cookStatus of ["standby", "cookEnd"]) {
      const { client } = fakeClient({
        getAirfryerStatus: { ...armed, cookStatus },
      });
      expect(await f.read(client, device("CAF-P583S-KEU"))).toEqual({
        "": onOff(false),
      });
    }
  });

  it("refuses on without a call and ends the cook on off", async () => {
    const { client, calls } = fakeClient();
    const d = device("CAF-DC601S-WUS");
    expect(await f.write(client, d, "", "onOff", "onOff", true)).toBe(false);
    expect(calls).toEqual([]);
    expect(await f.write(client, d, "", "onOff", "onOff", false)).toBe(true);
    expect(calls).toEqual([
      { api: "v2", method: "endCook", data: {}, options: { subDevice: true } },
    ]);
  });
});

describe("outlets", () => {
  it("reads and switches the WHOGPLUG with enabled", async () => {
    const f = family("WHOGPLUG");
    const { client, calls } = fakeClient({
      getOutletStatus: {
        enabled: true,
        voltage: 121.5,
        energy: 0.3,
        power: 12.4,
        current: 0.1,
        highestVoltage: 260,
        voltagePtStatus: false,
      },
    });
    const d = device("WHOGPLUG");
    expect(await f.read(client, d)).toEqual({ "": onOff(true) });
    expect(await f.write(client, d, "", "onOff", "onOff", false)).toBe(true);
    expect(calls).toEqual([
      { api: "v2", method: "getOutletStatus", data: undefined },
      { api: "v2", method: "setSwitch", data: { id: 0, enabled: false } },
    ]);
  });

  it("reads the ESW10 with getSwitch", async () => {
    const f = family("ESW10-USA");
    const { client, calls } = fakeClient({ getSwitch: { enabled: false } });
    const d = device("ESW10-USA");
    expect(await f.read(client, d)).toEqual({ "": onOff(false) });
    await f.write(client, d, "", "onOff", "onOff", true);
    expect(calls).toEqual([
      { api: "v2", method: "getSwitch", data: { id: 0 } },
      { api: "v2", method: "setSwitch", data: { id: 0, enabled: true } },
    ]);
  });

  it("uses getProperty and setProperty for the BSDOG plugs", async () => {
    const f = family("BSDOG01");
    const { client, calls } = fakeClient({
      getProperty: {
        powerSwitch_1: 1,
        realTimeVoltage: 230.1,
        realTimePower: 5.2,
        electricalEnergy: 1.5,
        protectionStatus: "normal",
        voltageUpperThreshold: 264,
        currentUpperThreshold: 16,
        scheduleNum: 0,
      },
    });
    const d = device("BSDOG01");
    expect(await f.read(client, d)).toEqual({ "": onOff(true) });
    await f.write(client, d, "", "onOff", "onOff", false);
    expect(calls).toEqual([
      {
        api: "v2",
        method: "getProperty",
        data: {
          properties: [
            "powerSwitch_1",
            "realTimeVoltage",
            "realTimePower",
            "electricalEnergy",
            "protectionStatus",
            "voltageUpperThreshold",
            "currentUpperThreshold",
            "scheduleNum",
          ],
        },
      },
      {
        api: "v2",
        method: "setProperty",
        data: { powerSwitch_1: 0 },
        options: { subDevice: true },
      },
    ]);
  });

  it("uses bypass v1 for the 10A and 15A outlets", async () => {
    const f = family("ESW15-USA");
    const { client, calls } = fakeClient({
      deviceDetail: {
        deviceStatus: "on",
        connectionStatus: "online",
        activeTime: 10,
        power: 1.5,
        voltage: 120,
        energy: 0.2,
      },
    });
    const d = device("ESW15-USA");
    expect(await f.read(client, d)).toEqual({ "": onOff(true) });
    await f.write(client, d, "", "onOff", "onOff", false);
    expect(calls).toEqual([
      { api: "v1", method: "deviceDetail", data: undefined },
      { api: "v1", method: "deviceStatus", data: { status: "off" } },
    ]);
  });

  it("adds switchNo 0 for the wall switch", async () => {
    const f = family("ESWL01");
    const { client, calls } = fakeClient({
      deviceDetail: {
        deviceStatus: "off",
        connectionStatus: "online",
        activeTime: 0,
      },
    });
    const d = device("ESWL01");
    expect(await f.read(client, d)).toEqual({ "": onOff(false) });
    await f.write(client, d, "", "onOff", "onOff", true);
    expect(calls[1]).toEqual({
      api: "v1",
      method: "deviceStatus",
      data: { status: "on", switchNo: 0 },
    });
  });

  it("reads a V1 device that deviceDetail reports offline as offline", async () => {
    for (const model of ["ESW01-EU", "ESWL03"]) {
      const { client } = fakeClient({
        deviceDetail: { deviceStatus: "on", connectionStatus: "offline" },
      });
      await expect(
        family(model).read(client, device(model)),
      ).rejects.toMatchObject({ kind: "offline" });
    }
  });

  it("ignores other attributes", async () => {
    const f = family("WHOGPLUG");
    const { client, calls } = fakeClient();
    const d = device("WHOGPLUG");
    expect(
      await f.write(client, d, "", "levelControl", "currentLevel", 3),
    ).toBe(true);
    expect(await f.write(client, d, "", "onOff", "onOff", null)).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("purifier-core", () => {
  // shaped like pyvesync PurifierCoreDetailsResult
  const core = (enabled: boolean, mode: string, level: number) => ({
    enabled,
    filter_life: 90,
    mode,
    level,
    device_error_code: 0,
    air_quality: 1,
    air_quality_value: 3,
    display: true,
    child_lock: false,
    configuration: { display: true, display_forever: false },
  });

  it("reads level thirds, auto and off", async () => {
    const f = family("Core300S");
    const read = async (status: object, model = "Core300S") =>
      family(model).read(
        fakeClient({ getPurifierStatus: status as Record<string, unknown> })
          .client,
        device(model),
      );
    expect(await read(core(true, "manual", 2))).toEqual({ "": fan(2, 66) });
    expect(await read(core(true, "manual", 1))).toEqual({ "": fan(1, 33) });
    expect(await read(core(true, "auto", 3))).toEqual({ "": fan(3, 100) });
    expect(await read(core(true, "auto", 2))).toEqual({ "": fan(2, 66) });
    expect(await read(core(false, "manual", 2))).toEqual({ "": fan(0, 0) });
    expect(await read(core(true, "manual", 2), "Core400S")).toEqual({
      "": fan(2, 50),
    });
    expect(await read(core(true, "sleep", 1), "LV-RH131S")).toEqual({
      "": fan(1, 33),
    });
    expect(await read(core(true, "sleep", 0))).toEqual({ "": fan(1, 33) });
    expect(f.units(device("Core300S"))).toEqual([
      { key: "", label: "", deviceType: "air_purifier" },
    ]);
    expect(f.initial(device("Core300S"))).toEqual({ "": fan(0, 0) });
  });

  it("switches on first, then sets the level", async () => {
    const f = family("Core400S");
    const { client, calls } = fakeClient({
      getPurifierStatus: core(false, "manual", 1),
    });
    const d = device("Core400S");
    await f.read(client, d);
    calls.length = 0;
    expect(
      await f.write(client, d, "", "fanControl", "percentSetting", 1),
    ).toBe(true);
    expect(
      await f.write(client, d, "", "fanControl", "percentSetting", 100),
    ).toBe(true);
    expect(calls).toEqual([
      { api: "v2", method: "setSwitch", data: { enabled: true, id: 0 } },
      {
        api: "v2",
        method: "setLevel",
        data: { id: 0, level: 1, type: "wind" },
      },
      {
        api: "v2",
        method: "setLevel",
        data: { id: 0, level: 4, type: "wind" },
      },
    ]);
  });

  it("switches off on 0", async () => {
    const f = family("Core600S");
    const { client, calls } = fakeClient({
      getPurifierStatus: core(true, "manual", 2),
    });
    const d = device("Core600S");
    await f.read(client, d);
    calls.length = 0;
    await f.write(client, d, "", "fanControl", "percentSetting", 0);
    await f.write(client, d, "", "fanControl", "fanMode", 0);
    expect(calls).toEqual([
      { api: "v2", method: "setSwitch", data: { enabled: false, id: 0 } },
      { api: "v2", method: "setSwitch", data: { enabled: false, id: 0 } },
    ]);
  });

  it("ignores percentCurrent, null and other clusters", async () => {
    const f = family("Core300S");
    const { client, calls } = fakeClient();
    const d = device("Core300S");
    for (const [cluster, attribute, value] of [
      ["fanControl", "percentCurrent", 50],
      ["fanControl", "percentSetting", null],
      ["fanControl", "fanMode", 6],
      ["onOff", "onOff", false],
    ] as const) {
      expect(await f.write(client, d, "", cluster, attribute, value)).toBe(
        true,
      );
    }
    expect(calls).toEqual([]);
  });
});

describe("purifier-v2", () => {
  // shaped like pyvesync PurifierVitalDetailsResult
  const vital = (powerSwitch: number, workMode: string, level: number) => ({
    powerSwitch,
    filterLifePercent: 80,
    workMode,
    manualSpeedLevel: level === 255 ? 1 : level,
    fanSpeedLevel: level,
    AQLevel: 1,
    PM25: 4,
    screenState: 1,
    childLockSwitch: 0,
    screenSwitch: 1,
    lightDetectionSwitch: 0,
    environmentLightState: 1,
    autoPreference: { autoPreferenceType: "default", roomSize: 600 },
    timerRemain: 0,
  });

  it("reads fanSpeedLevel 255 as the manual level, never 0 % while on", async () => {
    const read = async (status: object, model: string) =>
      family(model).read(
        fakeClient({ getPurifierStatus: status as Record<string, unknown> })
          .client,
        device(model),
      );
    expect(await read(vital(1, "manual", 3), "LAP-V201S-WUS")).toEqual({
      "": fan(3, 75),
    });
    expect(await read(vital(1, "sleep", 255), "LAP-V102S-WUS")).toEqual({
      "": fan(1, 25),
    });
    expect(
      await read(
        { ...vital(1, "auto", 255), manualSpeedLevel: 3 },
        "LAP-V201S-WUS",
      ),
    ).toEqual({ "": fan(3, 75) });
    expect(
      await read(
        { ...vital(1, "auto", 255), manualSpeedLevel: undefined },
        "LAP-EL551S-AUS",
      ),
    ).toEqual({ "": fan(1, 33) });
    expect(await read(vital(1, "auto", 2), "LAP-V102S-AEUR")).toEqual({
      "": fan(2, 50),
    });
    expect(await read(vital(0, "manual", 255), "LAP-V102S-WEU")).toEqual({
      "": fan(0, 0),
    });
    expect(await read(vital(1, "manual", 2), "LAP-EL551S-AUS")).toEqual({
      "": fan(2, 66),
    });
    expect(await read(vital(1, "turbo", 4), "LAP-EL551S-WEU")).toEqual({
      "": fan(3, 100),
    });
    expect(await read(vital(1, "manual", 1), "LAP-B851S-WUS")).toEqual({
      "": fan(1, 33),
    });
  });

  it("writes powerSwitch and manualSpeedLevel", async () => {
    const f = family("LAP-V102S-WUS");
    const { client, calls } = fakeClient();
    const d = device("LAP-V102S-WUS");
    await f.write(client, d, "", "fanControl", "fanMode", 2);
    await f.write(client, d, "", "fanControl", "fanMode", 0);
    expect(calls).toEqual([
      {
        api: "v2",
        method: "setSwitch",
        data: { powerSwitch: 1, switchIdx: 0 },
      },
      {
        api: "v2",
        method: "setLevel",
        data: { levelIdx: 0, manualSpeedLevel: 2, levelType: "wind" },
      },
      {
        api: "v2",
        method: "setSwitch",
        data: { powerSwitch: 0, switchIdx: 0 },
      },
    ]);
  });
});

describe("fan", () => {
  // shaped like pyvesync TowerFanResult
  const tower = (powerSwitch: number, workMode: string, level: number) => ({
    powerSwitch,
    workMode,
    manualSpeedLevel: level,
    fanSpeedLevel: level,
    screenState: 1,
    screenSwitch: 1,
    oscillationSwitch: 0,
    oscillationState: 0,
    muteSwitch: 0,
    muteState: 0,
    timerRemain: 0,
    temperature: 717,
    errorCode: 0,
    scheduleCount: 0,
  });

  it("reads the tower and the pedestal fan on twelve levels", async () => {
    const towerRead = fakeClient({
      getTowerFanStatus: tower(1, "normal", 6),
    });
    expect(
      await family("LTF-F422S-WUS").read(
        towerRead.client,
        device("LTF-F422S-WUS"),
      ),
    ).toEqual({ "": fan(2, 50) });
    expect(towerRead.calls[0].method).toBe("getTowerFanStatus");

    const pedestal = fakeClient({
      getFanStatus: {
        powerSwitch: 1,
        workMode: "turbo",
        fanSpeedLevel: 12,
        temperature: 250,
        muteSwitch: 0,
        muteState: 0,
        screenState: 1,
        screenSwitch: 1,
        horizontalOscillationState: 0,
        verticalOscillationState: 0,
        childLock: 0,
        errorCode: 0,
      },
    });
    expect(
      await family("LPF-R432S-AEU").read(
        pedestal.client,
        device("LPF-R432S-AEU"),
      ),
    ).toEqual({ "": fan(3, 100) });
    expect(pedestal.calls[0].method).toBe("getFanStatus");
  });

  it("rounds percent to levels at the edges", async () => {
    const f = family("LTF-F422S-KEU");
    const { client, calls } = fakeClient({
      getTowerFanStatus: tower(1, "normal", 6),
    });
    const d = device("LTF-F422S-KEU");
    await f.read(client, d);
    calls.length = 0;
    for (const percent of [1, 8, 9, 50, 100]) {
      await f.write(client, d, "", "fanControl", "percentSetting", percent);
    }
    await f.write(client, d, "", "fanControl", "percentSetting", 0);
    expect(calls.map((c) => c.data)).toEqual([
      { levelIdx: 0, manualSpeedLevel: 1, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 1, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 2, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 6, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 12, levelType: "wind" },
      { powerSwitch: 0, switchIdx: 0 },
    ]);
  });

  it("maps fanMode thirds back to the same third", async () => {
    const f = family("LTF-F422S-WUS");
    const { client, calls } = fakeClient({
      getTowerFanStatus: tower(1, "normal", 1),
    });
    const d = device("LTF-F422S-WUS");
    await f.read(client, d);
    calls.length = 0;
    for (const mode of [1, 2, 3, 4]) {
      await f.write(client, d, "", "fanControl", "fanMode", mode);
    }
    expect(calls.map((c) => c.data)).toEqual([
      { levelIdx: 0, manualSpeedLevel: 4, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 8, levelType: "wind" },
      { levelIdx: 0, manualSpeedLevel: 12, levelType: "wind" },
    ]);
    for (const [level, mode] of [
      [4, 1],
      [8, 2],
      [12, 3],
    ]) {
      const read = fakeClient({
        getTowerFanStatus: tower(1, "normal", level),
      });
      const state = await f.read(read.client, device("LTF-F422S-WUS"));
      expect(state[""][0].attributes.fanMode).toBe(mode);
    }
  });

  it("writes a shown percent back as the level that shows it", async () => {
    const cases: [string, number, string, (level: number) => object][] = [
      [
        "Core300S",
        3,
        "getPurifierStatus",
        (level) => ({ enabled: true, level, mode: "manual" }),
      ],
      [
        "LTF-F422S-KEU",
        12,
        "getTowerFanStatus",
        (level) => tower(1, "normal", level),
      ],
    ];
    for (const [model, levels, method, status] of cases) {
      for (let level = 1; level <= levels; level++) {
        const { client, calls } = fakeClient({
          [method]: status(level) as Record<string, unknown>,
        });
        const d = device(model);
        const state = await family(model).read(client, d);
        const percent = state[""][0].attributes.percentSetting;
        calls.length = 0;
        await family(model).write(
          client,
          d,
          "",
          "fanControl",
          "percentSetting",
          percent,
        );
        const data = calls[0].data as Record<string, unknown>;
        expect([model, data.level ?? data.manualSpeedLevel]).toEqual([
          model,
          level,
        ]);
      }
    }
  });
});

describe("humidifier", () => {
  it("has a switch and a humidity sensor", () => {
    const f = family("Classic300S");
    const d = device("Classic300S");
    expect(f.units(d)).toEqual([
      { key: "", label: "", deviceType: "on_off_plugin_unit" },
      { key: "humidity", label: "Humidity", deviceType: "humidity_sensor" },
    ]);
    expect(f.initial(d)).toEqual({
      "": onOff(false),
      humidity: [
        {
          clusterId: "relativeHumidityMeasurement",
          attributes: { measuredValue: null },
        },
      ],
    });
  });

  it("reads and switches the snake_case group", async () => {
    const f = family("Classic300S");
    // shaped like pyvesync ClassicLVHumidResult
    const { client, calls } = fakeClient({
      getHumidifierStatus: {
        enabled: true,
        humidity: 45,
        mist_virtual_level: 3,
        mist_level: 3,
        mode: "auto",
        water_lacks: false,
        humidity_high: false,
        water_tank_lifted: false,
        display: true,
        automatic_stop_reach_target: false,
        night_light_brightness: 0,
        configuration: {
          auto_target_humidity: 50,
          display: true,
          automatic_stop: true,
        },
      },
    });
    const d = device("Classic300S");
    expect(await f.read(client, d)).toEqual({
      "": onOff(true),
      humidity: [
        {
          clusterId: "relativeHumidityMeasurement",
          attributes: { measuredValue: 4500 },
        },
      ],
    });
    await f.write(client, d, "", "onOff", "onOff", false);
    await f.write(
      client,
      d,
      "humidity",
      "relativeHumidityMeasurement",
      "measuredValue",
      5000,
    );
    expect(calls).toEqual([
      { api: "v2", method: "getHumidifierStatus", data: undefined },
      { api: "v2", method: "setSwitch", data: { enabled: false, id: 0 } },
    ]);
  });

  it("reads and switches the camelCase group", async () => {
    const f = family("LEH-S601S-WUS");
    // shaped like pyvesync Superior6000SResult
    const { client, calls } = fakeClient({
      getHumidifierStatus: {
        powerSwitch: 0,
        humidity: 52,
        targetHumidity: 55,
        virtualLevel: 1,
        mistLevel: 1,
        workMode: "autoPro",
        waterLacksState: 0,
        waterTankLifted: 0,
        autoStopSwitch: 1,
        autoStopState: 0,
        screenSwitch: 1,
        screenState: 1,
        temperature: 690,
        filterLifePercent: 93,
      },
    });
    const d = device("LEH-S601S-WUS");
    const state = await f.read(client, d);
    expect(state[""]).toEqual(onOff(false));
    expect(state.humidity[0].attributes.measuredValue).toBe(5200);
    await f.write(client, d, "", "onOff", "onOff", true);
    expect(calls[1]).toEqual({
      api: "v2",
      method: "setSwitch",
      data: { powerSwitch: 1, switchIdx: 0 },
    });
  });

  it("puts the 1000S and the A603S in the camelCase group", async () => {
    for (const model of ["LUH-M101S-WUS", "LUH-A603S-WUS"]) {
      const { client, calls } = fakeClient();
      await family(model).write(
        client,
        device(model),
        "",
        "onOff",
        "onOff",
        true,
      );
      expect(calls[0].data).toEqual({ powerSwitch: 1, switchIdx: 0 });
    }
  });
});
