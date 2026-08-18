import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { VacuumAreaSwitchEndpoint } from "../../matter/endpoints/legacy/vacuum/vacuum-area-switch.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// #445: plugin devices mount as bare Endpoints in root.parts. The entity flows
// cast every part to EntityEndpoint, so one mounted plugin device broke every
// HA-to-Matter state update and the removal grace window deleted the plugin
// endpoints 65s after any refresh. Harness mirrors the 355 bringup: a real
// ServerNode, a real manager over a fake HA, plus one bare plugin part added
// exactly like onDeviceRegistered does.

const VACUUM = "vacuum.robot";

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

function makeHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  ha.entities[VACUUM] = { entity_id: VACUUM };
  ha.states[VACUUM] = {
    entity_id: VACUUM,
    state: "docked",
    attributes: { friendly_name: "Robot", supported_features: 4 },
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
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

function makeProvider(patterns: string[] = ["vacuum.*"]): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-445",
    name: "b",
    port: 0,
    filter: {
      include: patterns.map((value) => ({
        type: HomeAssistantMatcherType.Pattern,
        value,
      })),
      exclude: [],
      includeMode: "any",
    },
    featureFlags: {},
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

async function buildManager(ha: FakeHa, patterns?: string[]) {
  const provider = makeProvider(patterns);
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
    fireEvent() {},
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
    id: `bem445-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const client = { connection: {}, haRunning: true, runningSince: 0 };
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    client as any,
    registry,
    new FakeMappingStorage() as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    fakeLogger(),
  );
  managers.push(manager);
  await server.add(manager.root);
  return { manager, registry, ha, client };
}

// The exact shape onDeviceRegistered mounts: a bare Endpoint, no entityId,
// no mappedEntityIds, no updateStates.
async function addPluginPart(
  manager: BridgeEndpointManager,
): Promise<Endpoint> {
  const part = new Endpoint(OnOffPlugInUnitDevice, { id: "plugin_x" });
  await manager.root.add(part);
  return part;
}

function vacuumEndpoint(manager: BridgeEndpointManager): EntityEndpoint {
  const ep = [...manager.root.parts].find(
    (p) =>
      !(p instanceof VacuumAreaSwitchEndpoint) &&
      (p as EntityEndpoint).entityId === VACUUM,
  );
  if (!ep) throw new Error("vacuum endpoint not mounted");
  return ep as EntityEndpoint;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem445-"));
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

describe("plugin endpoints in entity flows (#445)", () => {
  it("updateStates with a changed set skips plugin parts and updates the entity", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    await addPluginPart(manager);

    const vacuum = vacuumEndpoint(manager);
    const spy = vi.spyOn(vacuum, "updateStates").mockResolvedValue();

    await expect(
      manager.updateStates(ha.states, new Set([VACUUM])),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(ha.states);
  });

  it("updateStates with changed === null skips plugin parts too", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    await addPluginPart(manager);

    const vacuum = vacuumEndpoint(manager);
    const spy = vi.spyOn(vacuum, "updateStates").mockResolvedValue();

    await expect(manager.updateStates(ha.states)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(ha.states);
  });

  it("reconcile never queues plugin parts for removal, they survive the grace window", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    const part = await addPluginPart(manager);
    await manager.refreshDevices();

    // biome-ignore lint/suspicious/noExplicitAny: reach the private grace map
    const pendingRemovals = (manager as any).pendingRemovals as Map<
      string,
      number
    >;
    expect(pendingRemovals.size).toBe(0);

    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 61_000);
    await manager.refreshDevices();

    expect([...manager.root.parts]).toContain(part);
    expect(pendingRemovals.size).toBe(0);
  });

  it("a plugin part that defines updateStates still stays out of reconcile", async () => {
    // Future plugin endpoint types may carry an updateStates method; entity
    // identity, not update capability, decides reconcile membership.
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    const part = await addPluginPart(manager);
    Object.assign(part, { updateStates: async () => {} });
    await manager.refreshDevices();

    // biome-ignore lint/suspicious/noExplicitAny: reach the private grace map
    const pendingRemovals = (manager as any).pendingRemovals as Map<
      string,
      number
    >;
    expect(pendingRemovals.size).toBe(0);

    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 61_000);
    await manager.refreshDevices();

    expect([...manager.root.parts]).toContain(part);
    expect(pendingRemovals.size).toBe(0);
  });

  it("isolation by a plugin part id never deletes the plugin endpoint", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    const part = await addPluginPart(manager);
    await manager.refreshDevices();

    await manager.isolateEntity("plugin_x");

    expect([...manager.root.parts]).toContain(part);
  });

  it("a failing queued state update is warned, not left unhandled", async () => {
    const ha = makeHa();
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();

    const vacuum = vacuumEndpoint(manager);
    vi.spyOn(vacuum, "updateStates").mockResolvedValue();

    const first = manager.updateStates(ha.states);
    // The queued batch hits the throwing merge, the first already passed it.
    vi.spyOn(registry, "mergeExternalStates").mockImplementation(() => {
      throw new Error("boom 445");
    });
    manager.updateStates(ha.states);
    await first;

    await vi.waitFor(() => {
      expect(lastLogger.warn).toHaveBeenCalledWith(
        "Queued state update failed:",
        expect.any(Error),
      );
    });
  });
});

// #438: while HA is restarting its whole registry reads empty, so endpoints
// got deleted, their Matter numbers erased, and controllers re-added the lot,
// wiping groups. A removal only counts when HA still reports other entities.
describe("empty registry removal guard (#438)", () => {
  // A non-vacuum entity keeps the HA registry non-empty while the vacuum is
  // gone from the bridge filter, so a real removal can be told from HA down.
  function addOtherEntity(ha: FakeHa) {
    ha.entities["light.x"] = { entity_id: "light.x" };
    ha.states["light.x"] = { ...ha.states[VACUUM], entity_id: "light.x" };
  }

  it("keeps the endpoint and its number when HA reports no entities", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    // HA down: the whole registry empties.
    ha.entities = {};
    ha.states = {};
    await manager.refreshDevices();
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    ha.snapshotGeneration++;
    await manager.refreshDevices();

    expect(vacuumEndpoint(manager).number).toBe(before);
  });

  it("deletes an entity that is really gone while HA is up", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    expect(() => vacuumEndpoint(manager)).not.toThrow();

    // The vacuum is removed but HA still has other entities.
    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    addOtherEntity(ha);
    await manager.refreshDevices();
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    ha.snapshotGeneration++;
    await manager.refreshDevices();

    const gone = [...manager.root.parts].every(
      (p) => (p as EntityEndpoint).entityId !== VACUUM,
    );
    expect(gone).toBe(true);
  });

  it("restarts the grace after HA comes back instead of deleting at once", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    // Vacuum gone, HA still up: the grace starts.
    const base = Date.now();
    let clock = base;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    addOtherEntity(ha);
    await manager.refreshDevices();

    // HA drops entirely mid-grace, then returns past the old grace.
    ha.entities = {};
    ha.states = {};
    clock = base + 150_000;
    ha.snapshotGeneration++;
    await manager.refreshDevices();
    addOtherEntity(ha);
    clock = base + 450_000;
    ha.snapshotGeneration++;
    await manager.refreshDevices();

    // The down window reset the grace, so it survives this refresh.
    expect(vacuumEndpoint(manager).number).toBe(before);
  });

  it("keeps everything while HA is not running", async () => {
    const ha = makeHa();
    const { manager, client } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    // Reconnect mid-HA-boot: snapshot is partial, vacuum missing, but the
    // client knows HA has not reached RUNNING again.
    client.haRunning = false;
    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    addOtherEntity(ha);
    await manager.refreshDevices();
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    ha.snapshotGeneration++;
    await manager.refreshDevices();

    expect(vacuumEndpoint(manager).number).toBe(before);
  });

  it("needs a fresh reload before deleting, a stale snapshot never confirms", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    addOtherEntity(ha);
    await manager.refreshDevices();

    // Grace elapsed but no reload succeeded since the stamp: keep.
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    await manager.refreshDevices();
    expect(vacuumEndpoint(manager).number).toBe(before);

    // A fresh reload still shows it gone: now it may go.
    ha.snapshotGeneration++;
    await manager.refreshDevices();
    const gone = [...manager.root.parts].every(
      (p) => (p as EntityEndpoint).entityId !== VACUUM,
    );
    expect(gone).toBe(true);
  });
});

describe("reconcile keeps working when a refresh goes wrong (#438)", () => {
  it("keeps the failed-entity list while HA is down", async () => {
    const ha = makeHa();
    const { manager, client } = await buildManager(ha);
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private list
    (manager as any)._failedEntities = [{ entityId: "light.x", reason: "r" }];

    client.haRunning = false;
    await manager.refreshDevices();

    expect(manager.failedEntities).toHaveLength(1);
  });

  it("stopObserving kills the recheck timer, bridges never call dispose", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();

    // The vacuum leaves, so a removal is held and the timer is armed.
    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    ha.entities["light.x"] = { entity_id: "light.x" };
    ha.states["light.x"] = { entity_id: "light.x", state: "on" };
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private timer
    expect((manager as any).removalRecheckTimer).not.toBeNull();

    // A stopped bridge must not keep a timer that deletes endpoints later.
    manager.stopObserving();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private timer
    expect((manager as any).removalRecheckTimer).toBeNull();
  });

  it("a composed sub-entity is closed, not deleted, so the flag can go back", async () => {
    const ha = makeHa();
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    // The entity gets absorbed into a composed device (#218).
    vi.spyOn(registry, "isAutoComposedDevicesEnabled").mockReturnValue(true);
    vi.spyOn(registry, "isComposedSubEntityUsed").mockImplementation(
      (id: string) => id === VACUUM,
    );
    await manager.refreshDevices();
    expect(() => vacuumEndpoint(manager)).toThrow();

    // Flag off again: the same endpoint id must return under its old number.
    vi.restoreAllMocks();
    await manager.refreshDevices();
    expect(vacuumEndpoint(manager).number).toBe(before);
  });

  it("re-arms the removal recheck when the recheck refresh itself throws", async () => {
    vi.useFakeTimers();
    const ha = makeHa();
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();

    // The vacuum leaves while HA is up, so a removal is now pending.
    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    ha.entities["light.x"] = { entity_id: "light.x" };
    ha.states["light.x"] = { entity_id: "light.x", state: "on" };
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private timer
    expect((manager as any).removalRecheckTimer).not.toBeNull();

    // The timer fires into a refresh that dies: the pending removal must not
    // be left with no timer to finish it.
    vi.spyOn(registry, "refresh").mockImplementationOnce(() => {
      throw new Error("boom 438");
    });
    await vi.advanceTimersByTimeAsync(306_000);

    // biome-ignore lint/suspicious/noExplicitAny: reach the private timer
    expect((manager as any).removalRecheckTimer).not.toBeNull();
    vi.useRealTimers();
  });
});

// #438 follow-up: transient matter.js errors used to delete() the endpoint,
// erasing the number, so the auto-recreate re-minted the device. close()
// keeps the number and the recreate keeps its identity.
describe("identity survives isolation and plugin stops (#438)", () => {
  it("an isolated entity comes back under the same number", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const before = vacuumEndpoint(manager).number;

    await manager.isolateEntity(VACUUM);
    expect(
      [...manager.root.parts].some(
        (p) => (p as EntityEndpoint).entityId === VACUUM,
      ),
    ).toBe(false);

    await manager.refreshDevices();
    expect(vacuumEndpoint(manager).number).toBe(before);
  });

  it("plugin endpoints keep their number across stopPlugins", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const part = await addPluginPart(manager);
    const before = part.number;

    // biome-ignore lint/suspicious/noExplicitAny: reach the private plugin state
    (manager as any).pluginManager = { shutdownAll: async () => {} };
    // biome-ignore lint/suspicious/noExplicitAny: reach the private plugin state
    (manager as any).pluginEndpoints.set("x", part);
    await manager.stopPlugins();
    expect([...manager.root.parts]).not.toContain(part);

    const again = await addPluginPart(manager);
    expect(again.number).toBe(before);
  });
});

// #450: a battery sensor that was unavailable when the endpoint was built
// never got picked up later. The resolved battery is part of the mapping
// fingerprint now, so the endpoint rebuilds once the sensor appears.
describe("battery sensor appearing after endpoint creation (#450)", () => {
  const BATTERY = "sensor.robot_battery";

  function haWithBattery(batteryState: string): FakeHa {
    const ha = makeHa();
    ha.entities[VACUUM].device_id = "dev450";
    ha.entities[BATTERY] = { entity_id: BATTERY, device_id: "dev450" };
    ha.devices.dev450 = { id: "dev450", name: "Robot" };
    ha.states[BATTERY] = {
      entity_id: BATTERY,
      state: batteryState,
      attributes: { device_class: "battery" },
      context: { id: "ctx" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    };
    return ha;
  }

  it("rebuilds the endpoint with the battery once the sensor resolves", async () => {
    const ha = haWithBattery("unavailable");
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = vacuumEndpoint(manager);
    expect(first.mappedEntityIds).not.toContain(BATTERY);

    ha.states[BATTERY].state = "85";
    registry.refresh();
    await manager.refreshDevices();
    const second = vacuumEndpoint(manager);
    expect(second).not.toBe(first);
    expect(second.mappedEntityIds).toContain(BATTERY);

    // stable afterwards, no rebuild churn
    registry.refresh();
    await manager.refreshDevices();
    expect(vacuumEndpoint(manager)).toBe(second);
  });

  it("an exposed battery sensor endpoint does not displace the vacuum candidate", async () => {
    // sensor.* inside the filter: the battery sensor mounts as its own
    // endpoint on the same device and must not steal the retry slot
    const ha = haWithBattery("unavailable");
    const { manager } = await buildManager(ha, ["vacuum.*", "sensor.*"]);
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: the retry only runs while observing
    (manager as any).observingRequested = true;
    const first = vacuumEndpoint(manager);
    expect(first.mappedEntityIds).not.toContain(BATTERY);

    ha.states[BATTERY].state = "85";
    await manager.updateStates(ha.states, new Set([BATTERY]));
    await new Promise((r) => setTimeout(r, 100));
    expect(vacuumEndpoint(manager)).not.toBe(first);
    expect(vacuumEndpoint(manager).mappedEntityIds).toContain(BATTERY);
  });

  it("a device move drops the kept battery mapping", async () => {
    const ha = haWithBattery("85");
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = vacuumEndpoint(manager);
    expect(first.mappedEntityIds).toContain(BATTERY);

    // sensor moves to another HA device while still existing: the mapping
    // must not survive on the old device
    ha.entities[BATTERY].device_id = "other-device";
    ha.states[BATTERY].state = "unavailable";
    registry.refresh();
    await manager.refreshDevices();
    const rebuilt = vacuumEndpoint(manager);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.mappedEntityIds).not.toContain(BATTERY);
  });

  it("no retry schedule after stopObserving, queued batches included", async () => {
    const ha = haWithBattery("unavailable");
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();

    manager.stopObserving();
    ha.states[BATTERY].state = "85";
    const refresh = vi.spyOn(manager, "refreshDevices");
    // the queued-batch path delivers states after the stop landed
    // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
    (manager as any).maybeRetryBatteryMapping(ha.states, new Set([BATTERY]));
    await new Promise((r) => setTimeout(r, 50));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an unavailable snapshot does not strip a mapped battery", async () => {
    const ha = haWithBattery("85");
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = vacuumEndpoint(manager);
    expect(first.mappedEntityIds).toContain(BATTERY);

    // HA restart snapshot: sensor briefly unavailable must not rebuild the
    // endpoint battery-less
    ha.states[BATTERY].state = "unavailable";
    registry.refresh();
    await manager.refreshDevices();
    expect(vacuumEndpoint(manager)).toBe(first);

    // the sensor entity leaving HA entirely does rebuild without it
    delete ha.entities[BATTERY];
    delete ha.states[BATTERY];
    registry.refresh();
    await manager.refreshDevices();
    const rebuilt = vacuumEndpoint(manager);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.mappedEntityIds).not.toContain(BATTERY);
  });

  it("subscribes the device sensors while the battery is unresolved", async () => {
    const ha = haWithBattery("unavailable");
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: pin the subscription list
    expect((manager as any).collectSubscriptionEntityIds()).toContain(BATTERY);
  });

  it("a state update alone triggers the rebuild, registry ticks skip state-only changes", async () => {
    const ha = haWithBattery("unavailable");
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: the retry only runs while observing
    (manager as any).observingRequested = true;
    const first = vacuumEndpoint(manager);
    expect(first.mappedEntityIds).not.toContain(BATTERY);

    ha.states[BATTERY].state = "85";
    await manager.updateStates(ha.states, new Set([BATTERY]));
    await new Promise((r) => setTimeout(r, 100));

    const second = vacuumEndpoint(manager);
    expect(second).not.toBe(first);
    expect(second.mappedEntityIds).toContain(BATTERY);

    // an unrelated later state batch does not rebuild again
    await manager.updateStates(ha.states, new Set([BATTERY]));
    await new Promise((r) => setTimeout(r, 100));
    expect(vacuumEndpoint(manager)).toBe(second);
  });
});
