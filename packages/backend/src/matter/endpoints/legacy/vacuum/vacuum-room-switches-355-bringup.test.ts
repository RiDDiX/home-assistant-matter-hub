import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeEndpointManager } from "../../../../services/bridges/bridge-endpoint-manager.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityIsolationService } from "../../../../services/bridges/entity-isolation-service.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type { EntityIdentityStorage } from "../../../../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../../../../services/storage/entity-mapping-storage.js";
import type { EntityEndpoint } from "../../entity-endpoint.js";
import { VacuumAreaSwitchEndpoint } from "./vacuum-area-switch.js";

// #355 / HARD RULE #419: opt-in per-area room switches. A vacuum with the
// vacuumRoomSwitches flag mounts the vacuum plus one momentary OnOffPlugInUnit
// sibling per service area under stable derived ids. Turning a switch on
// dispatches the right HA action for that area and auto-resets; without the flag
// only the vacuum mounts (its id/number untouched); flipping the flag off later
// removes only the switches.

const VACUUM = "vacuum.robot";
const ROOMS = { "16": "Kitchen", "17": "Bedroom" };
const VALETUDO = "vacuum.valetudo_bot";

// --- minimal in-memory storages (shape mirrors stable-identity.test.ts) ---

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
  private m = new Map<string, Map<string, EntityMappingConfig>>();
  put(b: string, cfg: EntityMappingConfig) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(cfg.entityId, cfg);
  }
  remove(b: string, e: string) {
    this.m.get(b)?.delete(e);
  }
  getMapping(b: string, e: string) {
    return this.m.get(b)?.get(e);
  }
  getMappingsForBridge(b: string) {
    return [...(this.m.get(b)?.values() ?? [])];
  }
  markMappingMissing() {}
  clearMappingMissing() {}
  async deleteMapping(b: string, e: string) {
    this.m.get(b)?.delete(e);
  }
  async deleteBridgeMappings(b: string) {
    this.m.delete(b);
  }
}

function asIdentity(s: FakeIdentityStorage) {
  return s as unknown as EntityIdentityStorage;
}
function asMapping(s: FakeMappingStorage) {
  return s as unknown as EntityMappingStorage;
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
}

function makeHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
  };
  // No device_id: keeps LegacyEndpoint on the plain vacuum path (no auto
  // battery/select/clean_area detection), rooms come straight from attributes.
  ha.entities[VACUUM] = { entity_id: VACUUM };
  ha.states[VACUUM] = {
    entity_id: VACUUM,
    state: "docked",
    attributes: {
      friendly_name: "Robot",
      supported_features: 4,
      rooms: ROOMS,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return ha;
}

function makeValetudoHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
  };
  // Valetudo shape: the vacuum entity has no rooms of its own, the segments
  // live on a sensor of the same device and get injected at creation time.
  ha.entities[VALETUDO] = { entity_id: VALETUDO, device_id: "valetudo-dev" };
  ha.entities["sensor.valetudo_bot_map_segments"] = {
    entity_id: "sensor.valetudo_bot_map_segments",
    device_id: "valetudo-dev",
  };
  ha.devices["valetudo-dev"] = { id: "valetudo-dev", name: "Valetudo Bot" };
  ha.states[VALETUDO] = {
    entity_id: VALETUDO,
    state: "docked",
    attributes: {
      friendly_name: "Valetudo Bot",
      supported_features: 4,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  ha.states["sensor.valetudo_bot_map_segments"] = {
    entity_id: "sensor.valetudo_bot_map_segments",
    state: "2",
    attributes: { "1": "Kitchen", "2": "Bedroom" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return ha;
}

// Injected-rooms vacuum WITHOUT the valetudo entity prefix: the dispatch
// depends on the rooms attribute, which only the creation-time effective
// snapshot carries. Raw HA state never has rooms.
const SEG = "vacuum.robo_seg";

function makeSegHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
  };
  ha.entities[SEG] = { entity_id: SEG, device_id: "seg-dev" };
  ha.entities["sensor.robo_seg_map_segments"] = {
    entity_id: "sensor.robo_seg_map_segments",
    device_id: "seg-dev",
  };
  ha.devices["seg-dev"] = { id: "seg-dev", name: "Robo Seg" };
  ha.states[SEG] = {
    entity_id: SEG,
    state: "docked",
    attributes: {
      friendly_name: "Robo Seg",
      supported_features: 4,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  ha.states["sensor.robo_seg_map_segments"] = {
    entity_id: "sensor.robo_seg_map_segments",
    state: "2",
    attributes: { "16": "Kitchen", "17": "Bedroom" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return ha;
}

let lastLogger: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function fakeLogger(): Logger {
  lastLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return lastLogger as unknown as Logger;
}

let dir: string;
let seq = 0;
let calls: HomeAssistantAction[];
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

function makeEnv(provider: BridgeDataProvider): Environment {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  return env;
}

function makeProvider(
  flags: Record<string, unknown>,
  bridgeId = "bridge-355",
): BridgeDataProvider {
  return new BridgeDataProvider({
    id: bridgeId,
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "vacuum.*" }],
      exclude: [],
      includeMode: "any",
    },
    featureFlags: flags,
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

async function buildManager(
  ha: FakeHa,
  mapping: FakeMappingStorage,
  bridgeId = "bridge-355",
): Promise<BridgeEndpointManager> {
  const provider = makeProvider({}, bridgeId);
  const env = makeEnv(provider);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `rs355-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {} } as any,
    registry,
    asMapping(mapping),
    asIdentity(new FakeIdentityStorage()),
    provider.id,
    fakeLogger(),
  );
  managers.push(manager);
  await server.add(manager.root);
  return manager;
}

function entityEndpoints(manager: BridgeEndpointManager): EntityEndpoint[] {
  return manager.root.parts.map((p) => p as EntityEndpoint);
}

function switchEndpoints(
  manager: BridgeEndpointManager,
): VacuumAreaSwitchEndpoint[] {
  return entityEndpoints(manager).filter(
    (p): p is VacuumAreaSwitchEndpoint => p instanceof VacuumAreaSwitchEndpoint,
  );
}

function vacuumEndpoint(
  manager: BridgeEndpointManager,
  entityId = VACUUM,
): EntityEndpoint {
  const ep = entityEndpoints(manager).find(
    (p) => !(p instanceof VacuumAreaSwitchEndpoint) && p.entityId === entityId,
  );
  if (!ep) throw new Error("vacuum endpoint not mounted");
  return ep;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-rs355-"));
  calls = [];
});

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.dispose().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    await s.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("vacuum room switches (#355)", () => {
  it("flag on: mounts the vacuum plus one switch per area with stable ids and names", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
    });
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    const vacuum = vacuumEndpoint(manager);
    expect(vacuum.id).toBe("vacuum_robot");

    const switches = switchEndpoints(manager);
    expect(switches.map((s) => s.id).sort()).toEqual([
      "vacuum_robot_roomsw_16",
      "vacuum_robot_roomsw_17",
    ]);
    const names = new Map<string, string>();
    for (const sw of switches) {
      await sw.construction.ready;
      await sw.act((agent) => {
        names.set(
          sw.id,
          // biome-ignore lint/suspicious/noExplicitAny: read basic info state
          (agent as any).bridgedDeviceBasicInformation.state.nodeLabel,
        );
      });
    }
    expect(names.get("vacuum_robot_roomsw_16")).toBe("Kitchen");
    expect(names.get("vacuum_robot_roomsw_17")).toBe("Bedroom");
  });

  it("turning a switch on dispatches the area's clean action and auto-resets", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
    });
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    const kitchen = switchEndpoints(manager).find(
      (s) => s.id === "vacuum_robot_roomsw_16",
    )!;
    await kitchen.construction.ready;

    let onOffImmediately: boolean | undefined;
    await kitchen.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      a.onOff.on();
      onOffImmediately = a.onOff.state.onOff;
    });
    // Momentary flip: on immediately, then auto-reset off (script pattern).
    expect(onOffImmediately).toBe(true);

    // Roborock rooms dict -> app_segment_clean for the single selected segment,
    // targeted at the vacuum entity.
    expect(calls).toEqual([
      {
        action: "vacuum.send_command",
        data: { command: "app_segment_clean", params: [16] },
      },
    ]);

    await delay(1200);
    let onOffLater: boolean | undefined;
    await kitchen.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read state
      onOffLater = (agent as any).onOff.state.onOff;
    });
    expect(onOffLater).toBe(false);
  });

  it("without the flag: only the vacuum mounts, no switches", async () => {
    const mapping = new FakeMappingStorage();
    // no mapping entry at all
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    expect(switchEndpoints(manager)).toHaveLength(0);
    expect(entityEndpoints(manager)).toHaveLength(1);
    expect(vacuumEndpoint(manager).id).toBe("vacuum_robot");
  });

  it("flipping the flag off removes the switches, vacuum id and number unchanged", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
    });
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    expect(switchEndpoints(manager)).toHaveLength(2);
    const before = vacuumEndpoint(manager);
    await before.construction.ready;
    const beforeId = before.id;
    const beforeNumber = before.number;

    // Turn the opt-in off; the mapping fingerprint change recreates the vacuum
    // endpoint under the same id (number preserved via close), and the switch
    // reconcile drops the now-orphaned switches.
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: false,
    });
    await manager.refreshDevices();

    expect(switchEndpoints(manager)).toHaveLength(0);
    const after = vacuumEndpoint(manager);
    await after.construction.ready;
    expect(after.id).toBe(beforeId);
    expect(after.number).toBe(beforeNumber);
  });

  it("a real entity claiming the synthetic id wins, the switch is skipped with a warn", async () => {
    const ha = makeHa();
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", { entityId: VACUUM, vacuumRoomSwitches: true });
    const manager = await buildManager(ha, mapping);
    await manager.refreshDevices();
    expect(switchEndpoints(manager)).toHaveLength(2);

    // A real entity whose derived endpoint id equals the switch's synthetic id.
    const CLAIMANT = "vacuum.robot_roomsw_16";
    ha.entities[CLAIMANT] = { entity_id: CLAIMANT };
    ha.states[CLAIMANT] = {
      entity_id: CLAIMANT,
      state: "docked",
      attributes: { friendly_name: "Claimant", supported_features: 4 },
      context: { id: "ctx" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    };
    await manager.refreshDevices();

    // Both mount: the entity wins the id, the colliding switch is dropped.
    expect(manager.failedEntities).toEqual([]);
    expect(vacuumEndpoint(manager, CLAIMANT).id).toBe("vacuum_robot_roomsw_16");
    expect(switchEndpoints(manager).map((s) => s.id)).toEqual([
      "vacuum_robot_roomsw_17",
    ]);
    const warned = lastLogger.warn.mock.calls.some(
      (c: unknown[]) =>
        String(c[0]).includes("vacuum_robot_roomsw_16") &&
        String(c[0]).includes(CLAIMANT),
    );
    expect(warned).toBe(true);
  });

  it("isolating the vacuum removes its switches and keeps them off while isolated", async () => {
    // isolateFromError parses a 32-hex bridge id from the endpoint path.
    const BID = "ab".repeat(16);
    const mapping = new FakeMappingStorage();
    mapping.put(BID, { entityId: VACUUM, vacuumRoomSwitches: true });
    const manager = await buildManager(makeHa(), mapping, BID);
    await manager.refreshDevices();
    expect(switchEndpoints(manager)).toHaveLength(2);

    const ok = await EntityIsolationService.isolateFromError(
      new Error(`Error initializing part ${BID}.aggregator.vacuum_robot`),
    );
    expect(ok).toBe(true);

    // Same pass: the vacuum is gone and so are its switches.
    expect(
      entityEndpoints(manager).filter((e) => e.entityId === VACUUM),
    ).toHaveLength(0);
    expect(switchEndpoints(manager)).toHaveLength(0);

    // The reconcile must not bring the switches back for an isolated parent.
    await manager.refreshDevices();
    expect(switchEndpoints(manager)).toHaveLength(0);
  });

  it("switches advertise their own serial, never the vacuum's", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
      customSerialNumber: "ABC",
    });
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    const serials: string[] = [];
    for (const ep of [vacuumEndpoint(manager), ...switchEndpoints(manager)]) {
      await ep.construction.ready;
      await ep.act((agent) => {
        serials.push(
          // biome-ignore lint/suspicious/noExplicitAny: read basic info state
          (agent as any).bridgedDeviceBasicInformation.state.serialNumber,
        );
      });
    }
    expect(serials).toHaveLength(3);
    expect(serials[0]).toBe("ABC");
    expect(new Set(serials).size).toBe(3);
  });

  it("valetudo: switches mirror the effective areas the cluster was built from", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VALETUDO,
      vacuumRoomSwitches: true,
    });
    const manager = await buildManager(makeValetudoHa(), mapping);
    await manager.refreshDevices();

    // The vacuum's ServiceArea cluster sees the injected map segments.
    const vacuum = vacuumEndpoint(manager, VALETUDO);
    await vacuum.construction.ready;
    let clusterAreaIds: number[] = [];
    await vacuum.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      clusterAreaIds = (agent as any).serviceArea.state.supportedAreas.map(
        // biome-ignore lint/suspicious/noExplicitAny: read cluster state
        (a: any) => a.areaId,
      );
    });
    expect([...clusterAreaIds].sort()).toEqual([1, 2]);

    // The switches must enumerate the exact same id space, not the raw state.
    const switches = switchEndpoints(manager);
    expect(switches.map((s) => s.areaId).sort()).toEqual([1, 2]);

    // Toggling dispatches the same Valetudo mqtt action the cluster path uses.
    const kitchen = switches.find((s) => s.areaId === 1)!;
    await kitchen.construction.ready;
    await kitchen.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).onOff.on();
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("mqtt.publish");
    const data = calls[0].data as { topic: string; payload: string };
    expect(data.topic).toBe("valetudo/bot/MapSegmentationCapability/clean/set");
    expect(JSON.parse(data.payload).segment_ids).toEqual(["1"]);

    // Drain the momentary auto-reset timer before teardown.
    await delay(1200);
  });

  it("switch dispatch survives a raw HA update that lacks the injected rooms", async () => {
    const ha = makeSegHa();
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", { entityId: SEG, vacuumRoomSwitches: true });
    const manager = await buildManager(ha, mapping);
    await manager.refreshDevices();

    const kitchen = switchEndpoints(manager).find((s) => s.areaId === 16);
    expect(kitchen).toBeDefined();
    await kitchen!.construction.ready;

    // Raw HA update: the entity itself never carries the injected rooms.
    await kitchen!.updateStates({
      [SEG]: {
        ...ha.states[SEG],
        state: "cleaning",
        last_updated: "2026-01-01T00:01:00",
      },
    });

    await kitchen!.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).onOff.on();
    });
    expect(calls).toEqual([
      {
        action: "vacuum.send_command",
        data: { command: "app_segment_clean", params: [16] },
      },
    ]);

    // Drain the momentary auto-reset timer before teardown.
    await delay(1200);
  });

  it("vacuum selectAreas/start dispatch survives a raw HA update too", async () => {
    const ha = makeSegHa();
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", { entityId: SEG, vacuumRoomSwitches: true });
    const manager = await buildManager(ha, mapping);
    await manager.refreshDevices();

    const vacuum = vacuumEndpoint(manager, SEG);
    await vacuum.construction.ready;

    await vacuum.updateStates({
      [SEG]: {
        ...ha.states[SEG],
        last_updated: "2026-01-01T00:01:00",
      },
    });
    // Flush the endpoint's 50ms update debounce.
    await delay(120);

    await vacuum.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the clusters
      const a = agent as any;
      a.serviceArea.state.selectedAreas = [16];
      a.rvcRunMode.changeToMode({ newMode: 1 });
    });
    expect(calls).toEqual([
      {
        action: "vacuum.send_command",
        data: { command: "app_segment_clean", params: [16] },
      },
    ]);
  });

  it("mapping edit: kept switches pick up the fresh mapping, number preserved", async () => {
    const mapping = new FakeMappingStorage();
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
      customServiceAreas: [{ name: "Zone A", service: "script.mow_a" }],
    });
    const manager = await buildManager(makeHa(), mapping);
    await manager.refreshDevices();

    const before = switchEndpoints(manager);
    expect(before.map((s) => s.id)).toEqual(["vacuum_robot_roomsw_1"]);
    await before[0].construction.ready;
    const beforeNumber = before[0].number;

    // Edit the area's service. The vacuum endpoint is recreated for the
    // mapping change, the switch must follow instead of keeping the old one.
    mapping.put("bridge-355", {
      entityId: VACUUM,
      vacuumRoomSwitches: true,
      customServiceAreas: [{ name: "Zone A", service: "script.mow_b" }],
    });
    await manager.refreshDevices();

    const after = switchEndpoints(manager);
    expect(after.map((s) => s.id)).toEqual(["vacuum_robot_roomsw_1"]);
    await after[0].construction.ready;
    expect(after[0].number).toBe(beforeNumber);

    calls = [];
    await after[0].act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).onOff.on();
    });
    expect(calls).toEqual([{ action: "script.mow_b" }]);

    // Drain the momentary auto-reset timer before teardown.
    await delay(1200);
  });
});
