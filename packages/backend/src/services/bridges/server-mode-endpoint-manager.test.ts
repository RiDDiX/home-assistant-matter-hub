import type { Logger } from "@matter/general";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../matter/endpoints/legacy/legacy-endpoint.js", () => ({
  LegacyEndpoint: { create: vi.fn() },
}));
vi.mock("../../matter/endpoints/server-mode-vacuum-endpoint.js", () => ({
  ServerModeVacuumEndpoint: { create: vi.fn() },
}));
vi.mock("../../utils/log-memory.js", () => ({
  isHeapUnderPressure: vi.fn(() => false),
}));
vi.mock("../home-assistant/api/subscribe-entities.js", () => ({
  subscribeEntities: vi.fn(() => vi.fn()),
}));

import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import type { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { ServerModeVacuumEndpoint } from "../../matter/endpoints/server-mode-vacuum-endpoint.js";
import { subscribeEntities } from "../home-assistant/api/subscribe-entities.js";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import type { BridgeRegistry } from "./bridge-registry.js";
import {
  MAX_SERVER_MODE_DEVICES,
  ServerModeEndpointManager,
} from "./server-mode-endpoint-manager.js";

function fakeEndpoint(
  entityId: string,
  opts?: { mappedEntityIds?: string[]; deviceType?: number; id?: string },
): EntityEndpoint {
  return {
    id: opts?.id ?? entityId.replace(/\./g, "_"),
    entityId,
    mappedEntityIds: opts?.mappedEntityIds ?? [],
    type: { deviceType: opts?.deviceType ?? 0x10 },
    delete: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    updateStates: vi.fn().mockResolvedValue(undefined),
  } as unknown as EntityEndpoint;
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

interface Harness {
  manager: ServerModeEndpointManager;
  serverNode: {
    addDevice: ReturnType<typeof vi.fn>;
    forgetDevice: ReturnType<typeof vi.fn>;
    clearDevices: ReturnType<typeof vi.fn>;
    updateDeviceIdentity: ReturnType<typeof vi.fn>;
    updateAdvertisedDeviceType: ReturnType<typeof vi.fn>;
  };
  registry: {
    refresh: ReturnType<typeof vi.fn>;
    entityIds: string[];
    firstEntityMatching: ReturnType<typeof vi.fn>;
    deviceOf: ReturnType<typeof vi.fn>;
    entity: ReturnType<typeof vi.fn>;
    initialState: ReturnType<typeof vi.fn>;
    mergeExternalStates: ReturnType<typeof vi.fn>;
    // biome-ignore lint/suspicious/noExplicitAny: registry stub
    fullEntities: Record<string, any>;
    snapshotGeneration: number;
  };
  client: { connection: object; haRunning: boolean; runningSince: number };
  mappingStorage: { getMapping: ReturnType<typeof vi.fn> };
  // biome-ignore lint/suspicious/noExplicitAny: harness data provider stub
  dataProvider: any;
}

interface HarnessOptions {
  flags?: Record<string, unknown>;
  entities?: Record<string, { unique_id?: string; platform?: string }>;
}

function makeHarness(
  entityIds: string[],
  primary?: string,
  opts?: HarnessOptions,
): Harness {
  const serverNode = {
    addDevice: vi.fn().mockResolvedValue(undefined),
    forgetDevice: vi.fn(),
    clearDevices: vi.fn(),
    updateDeviceIdentity: vi.fn().mockResolvedValue(undefined),
    updateAdvertisedDeviceType: vi.fn().mockResolvedValue(undefined),
  };
  // Full registry keyed by entity_id, carrying entity_id so orphan tombstone
  // stamping can compute identity keys from it.
  // HA always reports the configured entities, so the full registry is a
  // superset of entityIds. Seed it so the #438 HA-down guard sees HA as up.
  // biome-ignore lint/suspicious/noExplicitAny: registry stub
  const fullEntities: Record<string, any> = {};
  for (const id of entityIds) fullEntities[id] = { entity_id: id };
  for (const [id, value] of Object.entries(opts?.entities ?? {})) {
    fullEntities[id] = { entity_id: id, ...value };
  }
  const registry = {
    refresh: vi.fn(),
    entityIds,
    firstEntityMatching: vi.fn(() => primary ?? entityIds[0]),
    deviceOf: vi.fn(() => undefined),
    // biome-ignore lint/suspicious/noExplicitAny: registry stub
    entity: vi.fn((id: string) => (opts?.entities as any)?.[id]),
    initialState: vi.fn(() => undefined),
    mergeExternalStates: vi.fn(),
    fullEntities,
    snapshotGeneration: 1,
  };
  const mappingStorage = {
    getMapping: vi.fn(() => undefined),
    getMappingsForBridge: vi.fn(() => []),
    markMappingMissing: vi.fn(),
    clearMappingMissing: vi.fn(),
    setMapping: vi.fn(),
    deleteMapping: vi.fn(),
  };
  // Map-backed so a seeded identity survives across refreshes (rename tests).
  // biome-ignore lint/suspicious/noExplicitAny: identity record shape
  const identityStore = new Map<string, Map<string, any>>();
  const identityStorage = {
    getIdentity: (b: string, k: string) => identityStore.get(b)?.get(k),
    getBridgeIdentities: (b: string) => identityStore.get(b) ?? new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: identity record shape
    setIdentity: (b: string, k: string, r: any) => {
      let m = identityStore.get(b);
      if (!m) {
        m = new Map();
        identityStore.set(b, m);
      }
      m.set(k, r);
    },
    markIdentityMissing: (b: string, k: string, nowIso: string) => {
      const r = identityStore.get(b)?.get(k);
      if (!r || r.missingSince != null) return;
      r.missingSince = nowIso;
    },
    clearIdentityMissing: (b: string, k: string) => {
      const r = identityStore.get(b)?.get(k);
      if (!r || r.missingSince == null) return;
      r.missingSince = undefined;
    },
    deleteIdentity: vi.fn(),
    deleteBridgeIdentities: vi.fn(),
  };
  const dataProvider = {
    id: "bridge1",
    featureFlags: opts?.flags,
    filter: {
      include: entityIds.map((value) => ({
        type: "pattern",
        value,
      })),
      exclude: [],
    },
  };
  const client = { connection: {}, haRunning: true, runningSince: 0 };
  const manager = new ServerModeEndpointManager(
    serverNode as unknown as ServerModeServerNode,
    client as unknown as HomeAssistantClient,
    registry as unknown as BridgeRegistry,
    mappingStorage as unknown as EntityMappingStorage,
    identityStorage as unknown as EntityIdentityStorage,
    dataProvider as unknown as BridgeDataProvider,
    fakeLogger(),
  );
  managers.push(manager);
  return {
    manager,
    serverNode,
    registry,
    client,
    mappingStorage,
    dataProvider,
  };
}

// A refresh that represents a fresh successful HA reload past the grace, the
// two conditions an absence-driven delete has to meet (#438).
function passGrace(h: Harness) {
  const base = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
  h.registry.snapshotGeneration++;
}

const legacyCreate = vi.mocked(LegacyEndpoint.create);
const vacuumCreate = vi.mocked(ServerModeVacuumEndpoint.create);

const managers: ServerModeEndpointManager[] = [];

afterEach(async () => {
  // the removal recheck timer must not outlive its test
  for (const m of managers.splice(0)) {
    await m.dispose().catch(() => {});
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(subscribeEntities).mockClear();
  legacyCreate.mockReset();
  vacuumCreate.mockReset();
  legacyCreate.mockImplementation(
    async (_registry, entityId) =>
      fakeEndpoint(entityId as string) as unknown as LegacyEndpoint,
  );
  vacuumCreate.mockImplementation(
    async (_registry, entityId) =>
      fakeEndpoint(entityId as string, {
        deviceType: 0x74,
        mappedEntityIds: [],
      }) as unknown as ServerModeVacuumEndpoint,
  );
});

describe("ServerModeEndpointManager (#301)", () => {
  it("keeps the single-entity contract byte for byte", async () => {
    const h = makeHarness(["light.one"]);
    await h.manager.refreshDevices();

    expect(legacyCreate).toHaveBeenCalledTimes(1);
    expect(legacyCreate).toHaveBeenCalledWith(
      expect.anything(),
      "light.one",
      undefined,
      undefined,
      true,
      "light_one",
      "light.one",
    );
    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(1);
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(h.serverNode.updateDeviceIdentity.mock.calls[0][0]).toBe(
      "light.one",
    );
    expect(h.serverNode.updateAdvertisedDeviceType).toHaveBeenCalledTimes(1);
    expect(h.manager.failedEntities).toEqual([]);
  });

  it("creates nothing and skips identity on an unchanged second refresh", async () => {
    const h = makeHarness(["light.one"]);
    await h.manager.refreshDevices();
    legacyCreate.mockClear();
    h.serverNode.updateDeviceIdentity.mockClear();

    await h.manager.refreshDevices();

    expect(legacyCreate).not.toHaveBeenCalled();
    expect(h.serverNode.updateDeviceIdentity).not.toHaveBeenCalled();
  });

  it("creates one endpoint per entity with the primary first", async () => {
    const h = makeHarness(
      ["sensor.b", "light.primary", "sensor.c"],
      "light.primary",
    );
    await h.manager.refreshDevices();

    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(3);
    const firstAdded = h.serverNode.addDevice.mock
      .calls[0][0] as EntityEndpoint;
    expect(firstAdded.entityId).toBe("light.primary");
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(h.serverNode.updateDeviceIdentity.mock.calls[0][0]).toBe(
      "light.primary",
    );
  });

  it("caps the node and marks the surplus as failed", async () => {
    const ids = Array.from(
      { length: MAX_SERVER_MODE_DEVICES + 2 },
      (_, i) => `light.l${i}`,
    );
    const h = makeHarness(ids);
    await h.manager.refreshDevices();

    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(
      MAX_SERVER_MODE_DEVICES,
    );
    const capped = h.manager.failedEntities.filter((f) =>
      f.reason.includes("at most"),
    );
    expect(capped).toHaveLength(2);
  });

  it("keeps the others when one endpoint fails to create", async () => {
    legacyCreate.mockImplementation(async (_registry, entityId) =>
      entityId === "light.bad"
        ? undefined
        : (fakeEndpoint(entityId as string) as unknown as LegacyEndpoint),
    );
    const h = makeHarness(["light.good", "light.bad", "light.also"]);
    await h.manager.refreshDevices();

    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(2);
    expect(h.manager.failedEntities).toEqual([
      {
        entityId: "light.bad",
        reason: "Failed to create endpoint - unsupported device type",
      },
    ]);
  });

  it("uses the vacuum endpoint and skips entities the vacuum already claims", async () => {
    vacuumCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x74,
          mappedEntityIds: ["sensor.vac_battery"],
        }) as unknown as ServerModeVacuumEndpoint,
    );
    const h = makeHarness(["vacuum.robo", "sensor.vac_battery"], "vacuum.robo");
    await h.manager.refreshDevices();

    expect(vacuumCreate).toHaveBeenCalledTimes(1);
    expect(legacyCreate).not.toHaveBeenCalled();
    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(1);
    expect(h.manager.failedEntities).toEqual([
      {
        entityId: "sensor.vac_battery",
        reason: "Already exposed through vacuum.robo on this node.",
      },
    ]);
    const advertised = h.serverNode.updateAdvertisedDeviceType.mock.calls[0][0];
    expect(advertised).toBe(0x74);
  });

  it("deletes endpoints whose entity left the filter, but only past the grace", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    legacyCreate.mockClear();
    await h.manager.refreshDevices();

    // First absence only stamps the grace, nothing is deleted yet (#438).
    expect(endpointB?.delete).not.toHaveBeenCalled();

    passGrace(h);
    await h.manager.refreshDevices();

    expect(endpointB?.delete).toHaveBeenCalledTimes(1);
    expect(h.serverNode.forgetDevice).toHaveBeenCalledWith(endpointB);
    expect(legacyCreate).not.toHaveBeenCalled();
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.a"]);
  });

  it("keeps an absent endpoint when no fresh reload confirmed it (#438)", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    await h.manager.refreshDevices();

    // Time passes but the snapshot is the same cached one, so the recheck
    // must not delete from stale data.
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    await h.manager.refreshDevices();

    expect(endpointB?.delete).not.toHaveBeenCalled();
    expect(h.manager.devices.map((d) => d.entityId)).toContain("light.b");
  });

  it("keeps endpoints while HA is not running (#438)", async () => {
    const h = makeHarness(["light.a"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    h.client.haRunning = false;
    h.registry.entityIds = [];
    await h.manager.refreshDevices();
    passGrace(h);
    await h.manager.refreshDevices();

    expect(ep.delete).not.toHaveBeenCalled();
  });

  it("keeps its endpoint when HA reports no entities at all (#438)", async () => {
    const h = makeHarness(["light.a"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    // HA down: filtered and full registry both empty.
    h.registry.entityIds = [];
    for (const k of Object.keys(h.registry.fullEntities))
      delete h.registry.fullEntities[k];
    await h.manager.refreshDevices();

    expect(ep.delete).not.toHaveBeenCalled();
  });

  it("recreates an endpoint when its mapping fingerprint changes", async () => {
    const h = makeHarness(["light.one"]);
    await h.manager.refreshDevices();
    const first = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    h.mappingStorage.getMapping.mockReturnValue({ customName: "Neu" });
    h.serverNode.updateDeviceIdentity.mockClear();
    await h.manager.refreshDevices();

    expect(first.delete).toHaveBeenCalledTimes(1);
    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(2);
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);
  });

  it("rejects the later entity on an endpoint id collision", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    h.mappingStorage.getMapping.mockReturnValue({ customName: "Same Name" });
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          id: "Same_Name",
        }) as unknown as LegacyEndpoint,
    );
    await h.manager.refreshDevices();

    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(1);
    expect(h.manager.failedEntities).toEqual([
      {
        entityId: "light.b",
        reason: "Endpoint id collides with light.a. Set distinct custom names.",
      },
    ]);
  });

  it("fans state updates out to every endpoint after merging states", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpoints = h.serverNode.addDevice.mock.calls.map(
      (c) => c[0] as EntityEndpoint,
    );

    const states = { "light.a": { state: "on" } } as never;
    await h.manager.updateStates(states);

    expect(h.registry.mergeExternalStates).toHaveBeenCalledWith(states);
    for (const endpoint of endpoints) {
      expect(endpoint.updateStates).toHaveBeenCalledWith(states);
    }
  });

  it("closes every endpoint on dispose without deleting", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpoints = h.serverNode.addDevice.mock.calls.map(
      (c) => c[0] as EntityEndpoint,
    );

    await h.manager.dispose();

    for (const endpoint of endpoints) {
      expect(endpoint.close).toHaveBeenCalledTimes(1);
      expect(endpoint.delete).not.toHaveBeenCalled();
    }
    expect(h.manager.devices).toEqual([]);
  });

  it("renames via close() to keep the device number, root identity untouched (#404)", async () => {
    const reg = { unique_id: "U", platform: "hue" };
    const h = makeHarness(["light.old"], "light.old", {
      flags: { stableIdentity: true },
      entities: { "light.old": reg, "light.new": reg },
    });
    await h.manager.refreshDevices();
    const oldEndpoint = h.serverNode.addDevice.mock
      .calls[0][0] as EntityEndpoint;

    // rename: same unique_id + platform, new entity id
    h.registry.entityIds = ["light.new"];
    h.registry.firstEntityMatching = vi.fn(() => "light.new");
    h.serverNode.addDevice.mockClear();
    h.serverNode.updateDeviceIdentity.mockClear();

    await h.manager.refreshDevices();

    // old endpoint kept (close, not delete) so its number stays pre-allocated
    expect(oldEndpoint.close).toHaveBeenCalledTimes(1);
    expect(oldEndpoint.delete).not.toHaveBeenCalled();
    expect(h.serverNode.forgetDevice).toHaveBeenCalledWith(oldEndpoint);
    // rebuilt under the same frozen id for the renamed entity
    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(1);
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.new"]);
  });

  it("a rename resolving a pending absence drops the stamp (#438)", async () => {
    const reg = { unique_id: "U", platform: "hue" };
    const h = makeHarness(["light.old"], "light.old", {
      flags: { stableIdentity: true },
      entities: { "light.old": reg, "light.new": reg },
    });
    await h.manager.refreshDevices();

    // gone for one refresh, the grace stamp is set
    h.registry.entityIds = [];
    await h.manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private grace map
    const pending = (h.manager as any).pendingRemovals as Map<string, unknown>;
    expect(pending.size).toBe(1);

    // it returns renamed, the close path must clear the stamp too
    h.registry.entityIds = ["light.new"];
    h.registry.firstEntityMatching = vi.fn(() => "light.new");
    await h.manager.refreshDevices();
    expect(pending.size).toBe(0);
  });

  it("the recheck timer completes a held removal on its own (#438)", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    await h.manager.refreshDevices();
    expect(endpointB?.delete).not.toHaveBeenCalled();

    // A fresh reload lands, then the timer alone must finish the removal.
    h.registry.snapshotGeneration++;
    await vi.advanceTimersByTimeAsync(306_000);

    expect(endpointB?.delete).toHaveBeenCalledTimes(1);
  });

  it("subscribes once HA comes back, even though it started while HA was down (#438)", async () => {
    const h = makeHarness(["light.a"]);
    // Bridge starts while HA is down: nothing to subscribe to yet.
    const entityIds = h.registry.entityIds;
    h.client.haRunning = false;
    h.registry.entityIds = [];
    await h.manager.refreshDevices();
    await h.manager.startObserving();
    expect(vi.mocked(subscribeEntities)).not.toHaveBeenCalled();

    // HA returns with its entities: the subscription must come up now.
    h.client.haRunning = true;
    h.registry.entityIds = entityIds;
    await h.manager.refreshDevices();

    expect(vi.mocked(subscribeEntities)).toHaveBeenCalledTimes(1);
  });

  it("keeps subscribing to its last good entities while HA is down (#438)", async () => {
    const h = makeHarness(["light.a"]);
    await h.manager.refreshDevices();
    await h.manager.startObserving();
    vi.mocked(subscribeEntities).mockClear();

    // HA drops: the filtered list reads empty, but the subscription must
    // still cover the real entity when it is rebuilt.
    h.client.haRunning = false;
    h.registry.entityIds = [];
    await h.manager.refreshDevices();
    await h.manager.startObserving();

    expect(vi.mocked(subscribeEntities).mock.calls[0]?.[2]).toEqual([
      "light.a",
    ]);
  });

  it("stopObserving kills the recheck timer, bridges never call dispose (#438)", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    await h.manager.refreshDevices();

    // Bridge stops the way production does, then time passes.
    h.manager.stopObserving();
    h.registry.snapshotGeneration++;
    await vi.advanceTimersByTimeAsync(306_000);

    expect(endpointB?.delete).not.toHaveBeenCalled();
  });

  it("disabling an entity keeps its number for the re-enable (#438)", async () => {
    const h = makeHarness(["light.one"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    h.mappingStorage.getMapping.mockReturnValue({ disabled: true });
    await h.manager.refreshDevices();

    expect(ep.close).toHaveBeenCalledTimes(1);
    expect(ep.delete).not.toHaveBeenCalled();

    // Re-enable rebuilds under the same endpoint id, no collision.
    h.mappingStorage.getMapping.mockReturnValue(undefined);
    await h.manager.refreshDevices();
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.one"]);
    expect(h.manager.failedEntities).toEqual([]);
  });

  it("an endpoint that fails to close stays tracked so the id cannot clash (#438)", async () => {
    const h = makeHarness(["light.one"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;
    vi.mocked(ep.close).mockRejectedValue(new Error("close failed"));

    h.mappingStorage.getMapping.mockReturnValue({ disabled: true });
    await h.manager.refreshDevices();

    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.one"]);
    expect(h.serverNode.forgetDevice).not.toHaveBeenCalledWith(ep);
  });

  it("a bridge restart does not lose a held removal (#438)", async () => {
    vi.useFakeTimers();
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    await h.manager.refreshDevices();
    // Production start order: refreshDevices, then startObserving.
    await h.manager.startObserving();

    h.registry.snapshotGeneration++;
    await vi.advanceTimersByTimeAsync(306_000);

    expect(endpointB?.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps the failed-entity list while HA is down (#438)", async () => {
    legacyCreate.mockImplementation(async () => undefined);
    const h = makeHarness(["light.broken"]);
    await h.manager.refreshDevices();
    expect(h.manager.failedEntities).toHaveLength(1);

    h.client.haRunning = false;
    await h.manager.refreshDevices();

    expect(h.manager.failedEntities).toHaveLength(1);
  });

  it("waits out the grace from when HA came back, not from wall time (#438)", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    await h.manager.refreshDevices();

    // Grace elapsed on the wall clock, but HA only just came back, so its
    // slow integrations have not had their chance yet.
    const base = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => base + 301_000);
    h.client.runningSince = base + 300_000;
    h.registry.snapshotGeneration++;
    await h.manager.refreshDevices();
    expect(endpointB?.delete).not.toHaveBeenCalled();

    // HA has now been up longer than the grace.
    h.client.runningSince = base - 10_000;
    h.registry.snapshotGeneration++;
    await h.manager.refreshDevices();
    expect(endpointB?.delete).toHaveBeenCalledTimes(1);
  });

  it("holds the grace when the filter suddenly matches nothing (#438)", async () => {
    const h = makeHarness(["light.a"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    // Filter empties while HA still reports entities (partial snapshot).
    h.registry.entityIds = [];
    await h.manager.refreshDevices();
    expect(ep.delete).not.toHaveBeenCalled();

    passGrace(h);
    await h.manager.refreshDevices();
    expect(ep.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps the disabled and empty-filter failed-entity semantics", async () => {
    // HA itself is up with entities, the filter just matches none of them.
    const empty = makeHarness([], undefined, {
      entities: { "light.unrelated": {} },
    });
    await empty.manager.refreshDevices();
    expect(empty.manager.failedEntities[0]?.reason).toContain(
      "No Home Assistant entity matched",
    );

    const disabled = makeHarness(["light.off"]);
    disabled.mappingStorage.getMapping.mockReturnValue({ disabled: true });
    await disabled.manager.refreshDevices();
    expect(disabled.serverNode.addDevice).not.toHaveBeenCalled();
    expect(disabled.manager.failedEntities).toEqual([
      {
        entityId: "light.off",
        reason: "The configured entity is disabled for this bridge.",
      },
    ]);
  });
});
