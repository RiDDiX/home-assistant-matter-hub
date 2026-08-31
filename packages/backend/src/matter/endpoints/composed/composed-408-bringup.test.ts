import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityState,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../services/home-assistant/home-assistant-config.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../services/home-assistant/home-assistant-registry.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../aggregator-endpoint.js";
import { UserComposedEndpoint } from "./user-composed-endpoint.js";

// #408: a user picks composed sub-entities from the full HA registry, but the
// bridge filter only lets binary_sensor.* through. The old buildEntityPayload
// read the filtered maps, so the two sensors were invisible, got skipped, and
// the device dropped below 2 parts and fell back to standalone. The fix reads
// the full registry for sub-entities only.

const PRIMARY = "binary_sensor.occupancy";
const ILLUMINANCE = "sensor.illuminance";
const TEMPERATURE = "sensor.temperature";
const BATTERY = "sensor.battery";

function state(
  entityId: string,
  value: string,
  deviceClass: string,
  unit?: string,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes: {
      friendly_name: entityId,
      device_class: deviceClass,
      unit_of_measurement: unit,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

// three entities on one HA device, primary + two out-of-filter sensors
function haRegistry(): HomeAssistantRegistry {
  const entities = {
    [PRIMARY]: { entity_id: PRIMARY, device_id: "dev1" },
    [ILLUMINANCE]: { entity_id: ILLUMINANCE, device_id: "dev1" },
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [PRIMARY]: state(PRIMARY, "on", "occupancy"),
    [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
    [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
  };
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Hue Motion" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

function dataProvider(
  includePrimaryOnly: boolean,
  primaryOnParent = false,
): BridgeDataProvider {
  const include = includePrimaryOnly
    ? [{ type: HomeAssistantMatcherType.Pattern, value: "binary_sensor.*" }]
    : [];
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include, exclude: [], includeMode: "any" },
    featureFlags: {
      autoComposedDevices: true,
      composedPrimaryOnParent: primaryOnParent,
    },
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
}

function bridgeRegistry(
  includePrimaryOnly: boolean,
  primaryOnParent = false,
): BridgeRegistry {
  return new BridgeRegistry(
    haRegistry(),
    dataProvider(includePrimaryOnly, primaryOnParent),
  );
}

const composedEntities = [
  { entityId: ILLUMINANCE, matterDeviceType: "light_sensor" as const },
  { entityId: TEMPERATURE, matterDeviceType: "temperature_sensor" as const },
];

function create(registry: BridgeRegistry) {
  return UserComposedEndpoint.create({
    registry,
    primaryEntityId: PRIMARY,
    mapping: { entityId: PRIMARY },
    composedEntities,
  });
}

// primary + two out-of-filter sensors + a mapped battery on the same device
function haRegistryWithBattery(): HomeAssistantRegistry {
  const entities = {
    [PRIMARY]: { entity_id: PRIMARY, device_id: "dev1" },
    [ILLUMINANCE]: { entity_id: ILLUMINANCE, device_id: "dev1" },
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
    [BATTERY]: { entity_id: BATTERY, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [PRIMARY]: state(PRIMARY, "on", "occupancy"),
    [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
    [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    [BATTERY]: state(BATTERY, "80", "battery", "%"),
  };
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Hue Motion" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

// same as above, but the primary state also carries a battery_level attribute.
// The domain factory picks a WithBattery variant from that attribute alone, so
// without the strip the primary sub would get a second PowerSource.
function haRegistryWithPrimaryBatteryAttr(): HomeAssistantRegistry {
  const primary = state(PRIMARY, "on", "occupancy");
  (primary.attributes as Record<string, unknown>).battery_level = 80;
  const entities = {
    [PRIMARY]: { entity_id: PRIMARY, device_id: "dev1" },
    [ILLUMINANCE]: { entity_id: ILLUMINANCE, device_id: "dev1" },
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
    [BATTERY]: { entity_id: BATTERY, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [PRIMARY]: primary,
    [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
    [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    [BATTERY]: state(BATTERY, "80", "battery", "%"),
  };
  return {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Hue Motion" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
}

function createWithBattery(registry: BridgeRegistry) {
  return UserComposedEndpoint.create({
    registry,
    primaryEntityId: PRIMARY,
    mapping: { entityId: PRIMARY, batteryEntity: BATTERY },
    composedEntities,
  });
}

function createWithArea(registry: BridgeRegistry) {
  return UserComposedEndpoint.create({
    registry,
    primaryEntityId: PRIMARY,
    mapping: { entityId: PRIMARY },
    composedEntities,
    areaName: "Living Room",
  });
}

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-408-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider(true));
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
    getNumericState: () => undefined,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(endpoint: UserComposedEndpoint) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `composed408-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("user composed device with out-of-filter sub-entities (#408)", () => {
  it("composes sub-entities that do not match the bridge filter", async () => {
    const endpoint = await create(bridgeRegistry(true));

    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toContain(ILLUMINANCE);
    expect(endpoint!.mappedEntityIds).toContain(TEMPERATURE);
    // primary + two subs, so the "Cannot find" skip path was not taken
    expect([...endpoint!.parts].length).toBe(3);
  });

  it("keeps live updates flowing to an out-of-filter sub-endpoint", async () => {
    const endpoint = await create(bridgeRegistry(true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    const states: HomeAssistantStates = {
      [PRIMARY]: state(PRIMARY, "on", "occupancy"),
      [ILLUMINANCE]: state(ILLUMINANCE, "99", "illuminance", "lx"),
      [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    };
    await endpoint!.updateStates(states);
    await delay(200); // scheduleUpdate debounces 50ms then flushes async

    const sub = [...endpoint!.parts].find(
      (p) =>
        p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === ILLUMINANCE,
    );
    expect(sub).toBeDefined();
    expect(sub!.stateOf(HomeAssistantEntityBehavior).entity.state.state).toBe(
      "99",
    );
  });

  it("still composes when all sub-entities are inside the filter", async () => {
    const endpoint = await create(bridgeRegistry(false));

    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toEqual([ILLUMINANCE, TEMPERATURE]);
    expect([...endpoint!.parts].length).toBe(3);
  });
});

describe("user composed device battery and room label (#408)", () => {
  it("attaches the mapped battery to the parent and subscribes it", async () => {
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: () => undefined,
      getBatteryPercent: (id: string) => (id === BATTERY ? 80 : null),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);

    const registry = new BridgeRegistry(
      haRegistryWithBattery(),
      dataProvider(true),
    );
    const endpoint = await createWithBattery(registry);
    expect(endpoint).toBeDefined();
    expect(endpoint!.mappedEntityIds).toContain(BATTERY);

    await mount(endpoint!);
    await delay(50);

    // batPercentRemaining is half-percent units, so 80% becomes 160
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const power = (endpoint!.state as any).powerSource;
    expect(power.batPercentRemaining).toBe(160);
  });

  it("pushes a battery-only change to the parent PowerSource", async () => {
    // PowerSource reads the percent via EntityStateProvider, not the states
    // map, so drive the percent from a mutable stub value.
    let batteryPercent = 80;
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: () => undefined,
      getBatteryPercent: (id: string) =>
        id === BATTERY ? batteryPercent : null,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);

    const registry = new BridgeRegistry(
      haRegistryWithBattery(),
      dataProvider(true),
    );
    const endpoint = await createWithBattery(registry);
    expect(endpoint).toBeDefined();

    await mount(endpoint!);
    await delay(50);

    // 80% becomes 160 half-percent units at mount
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    expect((endpoint!.state as any).powerSource.batPercentRemaining).toBe(160);

    // Only the battery changed, the primary occupancy stays "on".
    batteryPercent = 55;
    const states: HomeAssistantStates = {
      [PRIMARY]: state(PRIMARY, "on", "occupancy"),
      [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
      [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
      [BATTERY]: state(BATTERY, "55", "battery", "%"),
    };
    await endpoint!.updateStates(states);
    await delay(200);

    // 55% becomes 110 half-percent units, must reach the parent PowerSource
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    expect((endpoint!.state as any).powerSource.batPercentRemaining).toBe(110);
  });

  it("keeps PowerSource only on the parent when the primary has a battery attribute", async () => {
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: () => undefined,
      getBatteryPercent: (id: string) => (id === BATTERY ? 80 : null),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);

    const registry = new BridgeRegistry(
      haRegistryWithPrimaryBatteryAttr(),
      dataProvider(true),
    );
    const endpoint = await createWithBattery(registry);
    expect(endpoint).toBeDefined();

    await mount(endpoint!);
    await delay(50);

    // the parent owns the device battery
    expect(endpoint!.behaviors.has("powerSource")).toBe(true);

    // the primary sub must not carry a duplicate PowerSource from the attribute
    const primary = [...endpoint!.parts].find(
      (p) =>
        p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === PRIMARY,
    );
    expect(primary).toBeDefined();
    expect(primary!.behaviors.has("powerSource")).toBe(false);
  });

  it("puts the room label on the parent and the primary sub", async () => {
    const endpoint = await createWithArea(bridgeRegistry(true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const parentLabels = (endpoint!.state as any).fixedLabel.labelList;
    expect(parentLabels).toContainEqual({
      label: "room",
      value: "Living Room",
    });

    const primary = [...endpoint!.parts].find(
      (p) =>
        p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === PRIMARY,
    );
    expect(primary).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off sub
    const primaryLabels = (primary!.state as any).fixedLabel.labelList;
    expect(primaryLabels).toContainEqual({
      label: "room",
      value: "Living Room",
    });
  });
});

// #469: a bare BridgedNodeEndpoint parent publishes deviceTypeList [0x0013]
// only, so Apple Home has no application device type on the accessory endpoint
// and derives the accessory category from one of the children (a composed light
// gets an outlet icon). With composedPrimaryOnParent the primary sits on the
// parent and the parent carries its device type, like an uncomposed entity.
describe("composed primary on the parent endpoint (#469)", () => {
  it("keeps the bare BridgedNode parent when the flag is off", async () => {
    const endpoint = await create(bridgeRegistry(true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const types = (endpoint!.state as any).descriptor.deviceTypeList;
    expect(types.map((t: { deviceType: number }) => t.deviceType)).toEqual([
      0x0013,
    ]);
    expect(endpoint!.behaviors.has("occupancySensing")).toBe(false);
    expect([...endpoint!.parts].length).toBe(3);
  });

  it("puts the primary device type and clusters on the parent when on", async () => {
    const endpoint = await create(bridgeRegistry(true, true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const types = (endpoint!.state as any).descriptor.deviceTypeList;
    const ids = types.map((t: { deviceType: number }) => t.deviceType);
    // OccupancySensor (0x0107) for the binary_sensor primary, plus BridgedNode
    expect(ids).toEqual([0x0107, 0x0013]);
    // the primary's cluster moved up to the parent, no _primary sub is left
    expect(endpoint!.behaviors.has("occupancySensing")).toBe(true);
    expect([...endpoint!.parts].length).toBe(2);
    expect(
      [...endpoint!.parts].some(
        (p) =>
          p.stateOf(HomeAssistantEntityBehavior).entity.entity_id === PRIMARY,
      ),
    ).toBe(false);
    // the parent still tracks the primary entity
    expect(
      endpoint!.stateOf(HomeAssistantEntityBehavior).entity.entity_id,
    ).toBe(PRIMARY);
    // and the grouped entities keep their own device types, which is the whole
    // point: the accessory reads as the primary, the children stay what they
    // are. LightSensor (0x0106) and TemperatureSensor (0x0302).
    const partTypes = [...endpoint!.parts].map((p) =>
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state off part
      (p.state as any).descriptor.deviceTypeList.map(
        (t: { deviceType: number }) => t.deviceType,
      ),
    );
    expect(partTypes).toEqual([[0x0106], [0x0302]]);
  });

  it("keeps live updates flowing to the merged parent", async () => {
    const endpoint = await create(bridgeRegistry(true, true));
    expect(endpoint).toBeDefined();
    await mount(endpoint!);

    await endpoint!.updateStates({
      [PRIMARY]: state(PRIMARY, "off", "occupancy"),
      [ILLUMINANCE]: state(ILLUMINANCE, "42", "illuminance", "lx"),
      [TEMPERATURE]: state(TEMPERATURE, "21.5", "temperature", "°C"),
    });
    await delay(200);

    expect(
      endpoint!.stateOf(HomeAssistantEntityBehavior).entity.state.state,
    ).toBe("off");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    expect((endpoint!.state as any).occupancySensing.occupancy.occupied).toBe(
      false,
    );
  });

  it("keeps the mapped battery on the merged parent", async () => {
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: () => undefined,
      getBatteryPercent: (id: string) => (id === BATTERY ? 80 : null),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);

    const registry = new BridgeRegistry(
      haRegistryWithBattery(),
      dataProvider(true, true),
    );
    const endpoint = await createWithBattery(registry);
    expect(endpoint).toBeDefined();
    await mount(endpoint!);
    await delay(50);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    expect((endpoint!.state as any).powerSource.batPercentRemaining).toBe(160);
  });

  // A vacuum brings its own PowerSource, which knows how to read the charge
  // state. Attaching the default one on top would replace it by behavior id.
  it("keeps a PowerSource the merged primary already brought", async () => {
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: () => undefined,
      getBatteryPercent: (id: string) => (id === BATTERY ? 80 : null),
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);

    const endpoint = await UserComposedEndpoint.create({
      registry: new BridgeRegistry(
        haRegistryWithBattery(),
        dataProvider(true, true),
      ),
      primaryEntityId: PRIMARY,
      mapping: {
        entityId: PRIMARY,
        matterDeviceType: "robot_vacuum_cleaner",
        batteryEntity: BATTERY,
      },
      composedEntities,
    });
    expect(endpoint).toBeDefined();
    await mount(endpoint!);
    await delay(50);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state off parent
    const powerSource = (endpoint!.state as any).powerSource;
    // only the vacuum config carries isCharging, the default one is battery only
    expect(typeof powerSource.config.isCharging).toBe("function");
    expect(powerSource.batPercentRemaining).toBe(160);
  });

  it("skips a sub-entity that repeats the primary or another sub", async () => {
    const endpoint = await UserComposedEndpoint.create({
      registry: bridgeRegistry(true, true),
      primaryEntityId: PRIMARY,
      mapping: { entityId: PRIMARY },
      composedEntities: [
        { entityId: ILLUMINANCE, matterDeviceType: "light_sensor" },
        // both are duplicates: the primary itself and a repeated sub
        { entityId: PRIMARY },
        { entityId: ILLUMINANCE, matterDeviceType: "light_sensor" },
      ],
    });

    expect(endpoint).toBeDefined();
    // the primary is the parent, so only the illuminance sub is left
    expect([...endpoint!.parts].length).toBe(1);
  });
});
