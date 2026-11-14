import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { type Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../home-assistant/home-assistant-config.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// #505: the composed or flat shape was chosen from auto-resolved companion
// sensors that were not part of the fingerprint. Sensor states arriving after
// the first refresh left the endpoint in its first shape until a restart.

const FAN = "fan.purifier";
const TEMP = "sensor.purifier_temperature";
const HUM = "sensor.purifier_humidity";
const HUM2 = "sensor.purifier_humidity_2";
const PRES = "sensor.purifier_pressure";

class FakeIdentityStorage {
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  private m = new Map<string, Map<string, any>>();
  getIdentity(b: string, k: string) {
    return this.m.get(b)?.get(k);
  }
  getBridgeIdentities(b: string) {
    return this.m.get(b) ?? new Map();
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal record store
  setIdentity(b: string, k: string, r: any) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(k, r);
  }
  markIdentityMissing() {}
  clearIdentityMissing() {}
  async deleteIdentity(b: string, k: string) {
    this.m.get(b)?.delete(k);
  }
  async deleteBridgeIdentities(b: string) {
    this.m.delete(b);
  }
}

class FakeMappingStorage {
  constructor(private readonly mapping?: EntityMappingConfig) {}
  getMapping(_b: string, entityId: string) {
    return entityId === this.mapping?.entityId ? this.mapping : undefined;
  }
  getMappingsForBridge() {
    return this.mapping ? [this.mapping] : [];
  }
  markMappingMissing() {}
  clearMappingMissing() {}
  async deleteMapping() {}
  async deleteBridgeMappings() {}
}

interface FakeHa {
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  entities: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  states: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  devices: Record<string, any>;
  areas: Map<string, string>;
  labels: unknown[];
  snapshotGeneration: number;
}

function st(id: string, state: string, attributes: Record<string, unknown>) {
  return {
    entity_id: id,
    state,
    attributes: { friendly_name: id, ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function setSensorStates(ha: FakeHa) {
  ha.states[TEMP] = st(TEMP, "21.5", {
    device_class: "temperature",
    unit_of_measurement: "°C",
    state_class: "measurement",
  });
  ha.states[HUM] = st(HUM, "48", {
    device_class: "humidity",
    unit_of_measurement: "%",
    state_class: "measurement",
  });
}

const SENSOR: Record<string, () => ReturnType<typeof st>> = {
  [TEMP]: () =>
    st(TEMP, "21.5", {
      device_class: "temperature",
      unit_of_measurement: "°C",
      state_class: "measurement",
    }),
  [HUM]: () =>
    st(HUM, "48", {
      device_class: "humidity",
      unit_of_measurement: "%",
      state_class: "measurement",
    }),
  [HUM2]: () =>
    st(HUM2, "52", {
      device_class: "humidity",
      unit_of_measurement: "%",
      state_class: "measurement",
    }),
  [PRES]: () =>
    st(PRES, "1013", {
      device_class: "pressure",
      unit_of_measurement: "hPa",
      state_class: "measurement",
    }),
};

function makeHa(withSensors: boolean): FakeHa {
  const ha: FakeHa = {
    entities: {
      [FAN]: { entity_id: FAN, device_id: "dev1" },
      [TEMP]: { entity_id: TEMP, device_id: "dev1" },
      [HUM]: { entity_id: HUM, device_id: "dev1" },
    },
    states: {
      [FAN]: st(FAN, "off", {
        supported_features: 57,
        percentage: 0,
        percentage_step: 1,
        preset_modes: ["Auto", "Silent", "Favorite"],
        preset_mode: "Auto",
      }),
    },
    devices: { dev1: { id: "dev1", name: "Mi Air Purifier 2" } },
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  if (withSensors) setSensorStates(ha);
  return ha;
}

const PURIFIER: EntityMappingConfig = {
  entityId: FAN,
  matterDeviceType: "air_purifier",
};

let dir: string;
let seq = 0;
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

async function buildManager(
  ha: FakeHa,
  include: string,
  featureFlags: Record<string, boolean>,
  mapping?: EntityMappingConfig,
) {
  const provider = new BridgeDataProvider({
    id: "bridge-505",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: include }],
      exclude: [],
      includeMode: "any",
    },
    featureFlags,
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any);
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", join(dir, `node-${seq}`));
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `bem505-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const logs: string[] = [];
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {}, haRunning: true, runningSince: 0 } as any,
    registry,
    new FakeMappingStorage(mapping) as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    {
      info: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  );
  managers.push(manager);
  await server.add(manager.root);
  await manager.refreshDevices();
  return { manager, logs };
}

function part(manager: BridgeEndpointManager, entityId: string) {
  const ep = [...manager.root.parts].find(
    (p) => (p as EntityEndpoint).entityId === entityId,
  );
  if (!ep) throw new Error(`${entityId} not mounted`);
  return ep;
}

// what a controller reads: numbers, device types and PartsList per endpoint
function shape(manager: BridgeEndpointManager) {
  const rows: unknown[] = [];
  const walk = (ep: Endpoint) => {
    // biome-ignore lint/suspicious/noExplicitAny: read descriptor state
    const d = (ep.state as any).descriptor;
    rows.push({
      id: ep.id,
      number: ep.number,
      types: d.deviceTypeList.map((t: { deviceType: number }) => t.deviceType),
      parts: [...d.partsList].sort(),
    });
    for (const child of ep.parts) walk(child);
  };
  walk(manager.root);
  return rows;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem505-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const m of managers.splice(0)) {
    await m.dispose().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    await s.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("composed air purifier shape (#505)", () => {
  const flags = { autoComposedDevices: true };

  it.each([
    "fan.*",
    "*",
  ])("recomposes when the sensors arrive late, filter %s", async (include) => {
    const clean = await buildManager(makeHa(true), include, flags, PURIFIER);
    // the sensor sub-endpoints need the sensors inside the filter
    expect([...part(clean.manager, FAN).parts]).toHaveLength(
      include === "*" ? 3 : 1,
    );

    const ha = makeHa(false);
    const late = await buildManager(ha, include, flags, PURIFIER);
    const flat = part(late.manager, FAN);
    expect([...flat.parts]).toHaveLength(0);

    setSensorStates(ha);
    await late.manager.refreshDevices();
    const composed = part(late.manager, FAN);
    expect(composed).not.toBe(flat);
    expect(composed.number).toBe(flat.number);
    expect(late.logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([
      `Mapping changed for ${FAN}, recreating endpoint`,
    ]);
    expect(shape(late.manager)).toEqual(shape(clean.manager));
  });

  it("stays composed when the sensor states vanish", async () => {
    const ha = makeHa(true);
    const { manager, logs } = await buildManager(ha, "*", flags, PURIFIER);
    const composed = part(manager, FAN);
    expect([...composed.parts]).toHaveLength(3);

    delete ha.states[TEMP];
    delete ha.states[HUM];
    await manager.refreshDevices();
    expect(part(manager, FAN)).toBe(composed);
    expect(logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([]);

    // and back, still the same endpoint
    setSensorStates(ha);
    await manager.refreshDevices();
    expect(part(manager, FAN)).toBe(composed);
  });

  it("an unchanged refresh does not rebuild", async () => {
    const { manager, logs } = await buildManager(
      makeHa(true),
      "fan.*",
      flags,
      PURIFIER,
    );
    const first = part(manager, FAN);
    await manager.refreshDevices();
    await manager.refreshDevices();
    expect(part(manager, FAN)).toBe(first);
    expect(logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([]);
  });
});

describe("temperature sensor humidity merge (#505)", () => {
  it.each([
    ["flat", {}],
    ["composed", { autoComposedDevices: true }],
  ])("picks up a humidity sensor that arrives late, %s", async (_label, flags) => {
    const clean = await buildManager(makeHa(true), "sensor.*", flags);

    const ha = makeHa(false);
    ha.states[TEMP] = st(TEMP, "21.5", {
      device_class: "temperature",
      unit_of_measurement: "°C",
      state_class: "measurement",
    });
    const late = await buildManager(ha, "sensor.*", flags);
    const first = part(late.manager, TEMP);

    setSensorStates(ha);
    await late.manager.refreshDevices();
    const rebuilt = part(late.manager, TEMP);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.number).toBe(first.number);
    expect(shape(late.manager)).toEqual(shape(clean.manager));
  });

  it("keeps the merged humidity when its state vanishes", async () => {
    const ha = makeHa(true);
    const { manager, logs } = await buildManager(ha, "sensor.*", {});
    const first = part(manager, TEMP);

    delete ha.states[HUM];
    await manager.refreshDevices();
    expect(part(manager, TEMP)).toBe(first);
    expect(logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([]);
  });
});

describe("stored companions (#505)", () => {
  const flags = { autoComposedDevices: true };

  it.each<[string, (ha: FakeHa) => void]>([
    [
      "deleted",
      (ha) => {
        for (const id of [TEMP, HUM]) {
          delete ha.entities[id];
          delete ha.states[id];
        }
      },
    ],
    [
      "moved to another device",
      (ha) => {
        for (const id of [TEMP, HUM]) {
          ha.entities[id] = { entity_id: id, device_id: "dev2" };
        }
      },
    ],
    [
      "disabled",
      (ha) => {
        for (const id of [TEMP, HUM]) {
          ha.entities[id] = { ...ha.entities[id], disabled_by: "user" };
          delete ha.states[id];
        }
      },
    ],
  ])("flattens a purifier whose sensors were %s", async (_label, change) => {
    const clean = await buildManager(makeHa(false), "fan.*", flags, PURIFIER);
    const ha = makeHa(true);
    const { manager, logs } = await buildManager(ha, "fan.*", flags, PURIFIER);
    expect(shape(manager)).not.toEqual(shape(clean.manager));

    change(ha);
    await manager.refreshDevices();
    expect(logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([
      `Mapping changed for ${FAN}, recreating endpoint`,
    ]);
    expect(shape(manager)).toEqual(shape(clean.manager));
  });

  it("keeps the first of two humidity sensors while it has no state", async () => {
    const ha = makeHa(true);
    ha.entities[HUM2] = { entity_id: HUM2, device_id: "dev1" };
    ha.states[HUM2] = SENSOR[HUM2]();
    const { manager, logs } = await buildManager(ha, TEMP, {});
    const first = part(manager, TEMP);

    delete ha.states[HUM];
    await manager.refreshDevices();
    ha.states[HUM] = SENSOR[HUM]();
    await manager.refreshDevices();
    expect(part(manager, TEMP)).toBe(first);
    expect(logs.filter((l) => l.startsWith("Mapping changed"))).toEqual([]);
  });
});

// The fingerprint has to follow every shape choice LegacyEndpoint.create
// makes: companions arriving on a later refresh must end in the shape a build
// with all states present has.
describe("late companions build the clean shape (#505)", () => {
  const composing = { autoComposedDevices: true };
  it.each<
    [
      string,
      string,
      string,
      Record<string, boolean>,
      EntityMappingConfig | undefined,
      string[],
      string[],
    ]
  >([
    // label, primary, filter, flags, mapping, present from the start, late
    [
      "plain fan without mapping",
      FAN,
      "*",
      composing,
      undefined,
      [],
      [TEMP, HUM],
    ],
    ["composing air purifier", FAN, "*", composing, PURIFIER, [], [TEMP, HUM]],
    [
      "composing air purifier with temperatureEntity, late humidity",
      FAN,
      "*",
      composing,
      { ...PURIFIER, temperatureEntity: TEMP },
      [TEMP],
      [HUM],
    ],
    ["air purifier, composing off", FAN, "*", {}, PURIFIER, [], [TEMP, HUM]],
    [
      "temperature sensor, late humidity",
      TEMP,
      "sensor.*",
      {},
      undefined,
      [],
      [HUM],
    ],
    [
      "temperature sensor, late pressure",
      TEMP,
      "sensor.*",
      {},
      undefined,
      [HUM],
      [PRES],
    ],
    [
      "temperature sensor, auto humidity and pressure off",
      TEMP,
      "sensor.*",
      { autoHumidityMapping: false, autoPressureMapping: false },
      undefined,
      [],
      [HUM, PRES],
    ],
    [
      "temperature sensor with composedEntities, composing off",
      TEMP,
      "sensor.*",
      {},
      { entityId: TEMP, composedEntities: [{ entityId: FAN }] },
      [],
      [HUM],
    ],
    [
      "temperature sensor with composedEntities, composing",
      TEMP,
      "sensor.*",
      composing,
      { entityId: TEMP, composedEntities: [{ entityId: FAN }] },
      [],
      [HUM],
    ],
    [
      "companion outside the bridge filter",
      FAN,
      "fan.*",
      composing,
      PURIFIER,
      [],
      [TEMP, HUM],
    ],
  ])("%s", async (_label, primary, include, flags, mapping, present, late) => {
    const make = () => {
      const ha = makeHa(false);
      ha.entities[PRES] = { entity_id: PRES, device_id: "dev1" };
      for (const id of [primary, ...present]) {
        ha.states[id] ??= SENSOR[id]();
      }
      return ha;
    };
    const cleanHa = make();
    for (const id of late) cleanHa.states[id] = SENSOR[id]();
    const clean = await buildManager(cleanHa, include, flags, mapping);

    const ha = make();
    const { manager } = await buildManager(ha, include, flags, mapping);
    for (const id of late) ha.states[id] = SENSOR[id]();
    await manager.refreshDevices();
    expect(shape(manager)).toEqual(shape(clean.manager));
  });
});
