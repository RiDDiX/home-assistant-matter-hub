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
    behaviors: { supported: {}, inject: vi.fn() },
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
    batteryFingerprintFor: ReturnType<typeof vi.fn>;
    forgetBatteryCacheForDevice: ReturnType<typeof vi.fn>;
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
  entities?: Record<
    string,
    { unique_id?: string; platform?: string; device_id?: string; name?: string }
  >;
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
    updateDeviceIdentity: vi.fn().mockResolvedValue(true),
    updateAdvertisedDeviceType: vi.fn().mockResolvedValue(true),
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
    initialState: vi.fn((): object | undefined => ({ state: "on" })),
    mergeExternalStates: vi.fn(),
    batteryFingerprintFor: vi.fn(() => ""),
    forgetBatteryCacheForDevice: vi.fn(),
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

  // #467: server mode keeps the identity on the root node, not on the child, so
  // the bridge-mode registry snapshot refresh does not reach it. A rename
  // changes no endpoint, so it must not be gated on a structural change.
  it("pushes the identity again when the device was renamed", async () => {
    const h = makeHarness(["light.one"]);
    h.registry.deviceOf.mockReturnValue({ id: "d1", name: "Old" });
    await h.manager.refreshDevices();
    h.serverNode.updateDeviceIdentity.mockClear();

    // unchanged refresh still does nothing
    await h.manager.refreshDevices();
    expect(h.serverNode.updateDeviceIdentity).not.toHaveBeenCalled();

    h.registry.deviceOf.mockReturnValue({ id: "d1", name: "New" });
    await h.manager.refreshDevices();

    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(h.serverNode.updateDeviceIdentity.mock.calls[0][1]).toMatchObject({
      name: "New",
    });
  });

  // #276: server mode ignored preferEntityRegistryName
  it("hands the registry name to the root node with preferEntityRegistryName", async () => {
    const flagged = makeHarness(["light.one"], undefined, {
      flags: { preferEntityRegistryName: true },
      entities: { "light.one": { name: "Registry Name" } },
    });
    flagged.registry.initialState.mockReturnValue({
      attributes: { friendly_name: "Friendly" },
    });
    await flagged.manager.refreshDevices();
    expect(flagged.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);
    expect(flagged.serverNode.updateDeviceIdentity.mock.calls[0][3]).toBe(
      "Registry Name",
    );

    const plain = makeHarness(["light.one"], undefined, {
      entities: { "light.one": { name: "Registry Name" } },
    });
    plain.registry.initialState.mockReturnValue({
      attributes: { friendly_name: "Friendly" },
    });
    await plain.manager.refreshDevices();
    expect(plain.serverNode.updateDeviceIdentity.mock.calls[0][3]).toBe(
      "Friendly",
    );
  });

  // The server node reports a failed identity write instead of throwing, so the
  // manager must not remember it as delivered (#467).
  it("retries the identity on the next refresh when the push failed", async () => {
    const h = makeHarness(["light.one"]);
    h.registry.deviceOf.mockReturnValue({ id: "d1", name: "Old" });
    await h.manager.refreshDevices();

    h.serverNode.updateDeviceIdentity.mockClear();
    h.serverNode.updateDeviceIdentity.mockResolvedValue(false);
    h.registry.deviceOf.mockReturnValue({ id: "d1", name: "New" });
    await h.manager.refreshDevices();
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(1);

    // nothing else changed, but the rename never landed, so try again
    h.serverNode.updateDeviceIdentity.mockResolvedValue(true);
    await h.manager.refreshDevices();
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(2);

    // and once it landed, stop
    await h.manager.refreshDevices();
    expect(h.serverNode.updateDeviceIdentity).toHaveBeenCalledTimes(2);
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

  it("rebuilds a mounted switch with a TagList once a second one joins", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x010a,
        }) as unknown as LegacyEndpoint,
    );
    const tagOf = (e: EntityEndpoint) =>
      // biome-ignore lint/suspicious/noExplicitAny: injected descriptor type
      (e.behaviors.inject as any).mock.calls[0]?.[0].defaults.tagList[0].tag;
    const h = makeHarness(["switch.b"]);
    await h.manager.refreshDevices();
    const first = h.manager.devices[0];
    expect(first.behaviors.inject).not.toHaveBeenCalled();

    h.registry.entityIds = ["switch.b", "switch.a"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    await h.manager.refreshDevices();

    // the untagged one closes (keeps its number) before a tagged sibling lands
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(first.close).mock.invocationCallOrder[0]).toBeLessThan(
      h.serverNode.addDevice.mock.invocationCallOrder[1],
    );
    const added = h.serverNode.addDevice.mock.calls
      .slice(1)
      .map((c) => c[0] as EntityEndpoint);
    expect(added.map((e) => [e.entityId, tagOf(e)])).toEqual([
      ["switch.a", 1],
      ["switch.b", 2],
    ]);

    h.serverNode.addDevice.mockClear();
    await h.manager.refreshDevices();
    expect(h.serverNode.addDevice).not.toHaveBeenCalled();
  });

  it("rebuilds for a tag on the id it is mounted under", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x010a,
        }) as unknown as LegacyEndpoint,
    );
    legacyCreate.mockImplementationOnce(
      async () =>
        fakeEndpoint("switch.b", {
          deviceType: 0x010a,
          id: "switch_b_old",
        }) as unknown as LegacyEndpoint,
    );
    const h = makeHarness(["switch.b"]);
    await h.manager.refreshDevices();

    h.registry.entityIds = ["switch.b", "switch.a"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    await h.manager.refreshDevices();

    const rebuild = legacyCreate.mock.calls.filter((c) => c[1] === "switch.b");
    expect(rebuild).toHaveLength(2);
    expect(rebuild[1][5]).toBe("switch_b_old");
  });

  it("stores the fingerprint a tag rebuild actually built (#450)", async () => {
    // the first build maps the battery, the tag rebuild misses it
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x0302,
        }) as unknown as LegacyEndpoint,
    );
    legacyCreate.mockImplementationOnce(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x0302,
          mappedEntityIds: ["sensor.bat"],
        }) as unknown as LegacyEndpoint,
    );
    const h = makeHarness(["sensor.t_b"]);
    h.registry.batteryFingerprintFor.mockImplementation((id: string) =>
      id === "sensor.t_b" ? "sensor.bat" : "",
    );
    await h.manager.refreshDevices();

    h.registry.entityIds = ["sensor.t_b", "sensor.t_a"];
    h.registry.fullEntities["sensor.t_a"] = { entity_id: "sensor.t_a" };
    await h.manager.refreshDevices();
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual([
      "sensor.t_b",
      "sensor.t_a",
      "sensor.t_b",
    ]);

    // the battery it left out still gets its catch-up rebuild
    legacyCreate.mockClear();
    await h.manager.refreshDevices();
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual(["sensor.t_b"]);
  });

  it("leaves a held sibling alone when a new one would renumber it (#438)", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x010a,
        }) as unknown as LegacyEndpoint,
    );
    const h = makeHarness(["switch.b"]);
    await h.manager.refreshDevices();
    const held = h.manager.devices[0];

    // switch.b left HA and waits out the grace while switch.a joins
    h.registry.entityIds = ["switch.a"];
    delete h.registry.fullEntities["switch.b"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    legacyCreate.mockClear();
    await h.manager.refreshDevices();

    expect(held.close).not.toHaveBeenCalled();
    expect(held.delete).not.toHaveBeenCalled();
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual(["switch.a"]);
    expect(h.manager.devices).toContain(held);
  });

  it("numbers each device type on its own, a light change leaves the locks alone", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: (entityId as string).startsWith("lock.")
            ? 0x000a
            : 0x0100,
        }) as unknown as LegacyEndpoint,
    );
    const tagOf = (e: EntityEndpoint) =>
      // biome-ignore lint/suspicious/noExplicitAny: injected descriptor type
      (e.behaviors.inject as any).mock.calls[0]?.[0].defaults.tagList[0].tag;
    const h = makeHarness(["light.l_a", "light.l_b", "lock.k_a", "lock.k_b"]);
    await h.manager.refreshDevices();
    const locks = h.manager.devices.filter((e) =>
      e.entityId.startsWith("lock"),
    );
    expect(locks.map(tagOf)).toEqual([1, 2]);

    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.l_a" ? { disabled: true } : undefined,
    );
    legacyCreate.mockClear();
    await h.manager.refreshDevices();

    // only the light that lost its twin is rebuilt
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual(["light.l_b"]);
    for (const lock of locks) expect(lock.close).not.toHaveBeenCalled();
    expect(h.manager.devices).toEqual(expect.arrayContaining(locks));
  });

  it("keeps tracking a sibling it could not close for a tag rebuild", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x010a,
        }) as unknown as LegacyEndpoint,
    );
    const h = makeHarness(["switch.b"]);
    await h.manager.refreshDevices();
    const first = h.manager.devices[0];
    vi.mocked(first.close).mockRejectedValueOnce(new Error("busy"));

    h.registry.entityIds = ["switch.b", "switch.a"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    await h.manager.refreshDevices();

    // still mounted, so it is neither built twice nor dropped
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual([
      "switch.b",
      "switch.a",
    ]);
    expect(h.manager.devices).toContain(first);

    // and the next refresh tries again
    await h.manager.refreshDevices();
    expect(legacyCreate.mock.calls.map((c) => c[1])).toEqual([
      "switch.b",
      "switch.a",
      "switch.b",
    ]);
  });

  it("leaves a sibling without an HA state mounted instead of rebuilding it", async () => {
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x010a,
        }) as unknown as LegacyEndpoint,
    );
    const h = makeHarness(["switch.b"]);
    await h.manager.refreshDevices();
    const first = h.manager.devices[0];

    // still in the registry, but HA has no state for it right now
    h.registry.initialState.mockImplementation((id: string) =>
      id === "switch.b" ? undefined : { state: "on" },
    );
    h.registry.entityIds = ["switch.b", "switch.a"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    await h.manager.refreshDevices();

    expect(first.close).not.toHaveBeenCalled();
    expect(h.manager.devices).toContain(first);
    expect(h.manager.failedEntities).toEqual([]);
  });

  it("retries a device whose mount failed on the next refresh", async () => {
    const h = makeHarness(["light.one"]);
    h.serverNode.addDevice.mockRejectedValueOnce(new Error("mount failed"));
    await h.manager.refreshDevices();
    expect(h.manager.failedEntities.map((f) => f.entityId)).toEqual([
      "light.one",
    ]);
    expect(h.manager.devices).toEqual([]);

    await h.manager.refreshDevices();
    expect(h.serverNode.addDevice).toHaveBeenCalledTimes(2);
    expect(h.manager.devices).toHaveLength(1);
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

  it("reports a create that threw as incomplete until a later one mounts it", async () => {
    legacyCreate.mockRejectedValueOnce(new Error("create failed"));
    const h = makeHarness(["light.one"]);
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(h.manager.devices).toEqual([]);

    await expect(h.manager.refreshDevices()).resolves.toBe(true);
    expect(h.manager.devices).toHaveLength(1);
  });

  it("logs a create that keeps failing once", async () => {
    legacyCreate.mockRejectedValue(new Error("create failed"));
    const h = makeHarness(["light.one"]);
    // biome-ignore lint/suspicious/noExplicitAny: reach the private logger
    const log = (h.manager as any).log as Logger;
    for (let i = 0; i < 3; i++) {
      await expect(h.manager.refreshDevices()).resolves.toBe(false);
    }
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      "Failed to create server mode device light.one:",
      expect.any(Error),
    );
  });

  it("stops marking a refresh incomplete after three failures with one reason", async () => {
    let reason: string | undefined = "create failed";
    legacyCreate.mockImplementation(async (_registry, entityId) => {
      if (reason) throw new Error(reason);
      return fakeEndpoint(entityId as string) as unknown as LegacyEndpoint;
    });
    const h = makeHarness(["light.one"]);
    // biome-ignore lint/suspicious/noExplicitAny: reach the private logger
    const log = (h.manager as any).log as Logger;
    for (let i = 0; i < 3; i++) {
      await expect(h.manager.refreshDevices()).resolves.toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      await expect(h.manager.refreshDevices()).resolves.toBe(true);
      expect(h.manager.failedEntities.map((f) => f.entityId)).toEqual([
        "light.one",
      ]);
    }
    expect(log.error).toHaveBeenCalledTimes(1);

    reason = "another reason";
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(2);

    reason = undefined;
    await expect(h.manager.refreshDevices()).resolves.toBe(true);
    expect(h.manager.devices).toHaveLength(1);

    // a success starts the count over
    reason = "create failed";
    h.mappingStorage.getMapping.mockReturnValue({ customName: "changed" });
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(3);
  });

  it("logs an add that keeps failing in full once and stops marking it incomplete", async () => {
    const h = makeHarness(["light.one"]);
    h.serverNode.addDevice.mockRejectedValue(new Error("add failed"));
    // biome-ignore lint/suspicious/noExplicitAny: reach the private logger
    const log = (h.manager as any).log as Logger;
    for (let i = 0; i < 3; i++) {
      await expect(h.manager.refreshDevices()).resolves.toBe(false);
    }
    await expect(h.manager.refreshDevices()).resolves.toBe(true);
    expect(h.manager.failedEntities.map((f) => f.entityId)).toEqual([
      "light.one",
    ]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      "Failed to create server mode device light.one:",
      expect.any(Error),
    );
  });

  it("logs a failure in full again after the entity left the node and came back", async () => {
    legacyCreate.mockImplementation(async (_registry, entityId) => {
      if (entityId === "light.one") throw new Error("create failed");
      return fakeEndpoint(entityId as string) as unknown as LegacyEndpoint;
    });
    const h = makeHarness(["light.one", "light.two"]);
    // biome-ignore lint/suspicious/noExplicitAny: reach the private logger
    const log = (h.manager as any).log as Logger;
    await h.manager.refreshDevices();
    h.registry.entityIds = ["light.two"];
    await h.manager.refreshDevices();
    h.registry.entityIds = ["light.one", "light.two"];
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("reports a tag rebuild that threw as incomplete and logs it once", async () => {
    let failRebuild = false;
    legacyCreate.mockImplementation(async (_registry, entityId) => {
      if (failRebuild && entityId === "switch.b") {
        throw new Error("rebuild failed");
      }
      return fakeEndpoint(entityId as string, {
        deviceType: 0x010a,
      }) as unknown as LegacyEndpoint;
    });
    const h = makeHarness(["switch.b"]);
    // biome-ignore lint/suspicious/noExplicitAny: reach the private logger
    const log = (h.manager as any).log as Logger;
    await h.manager.refreshDevices();

    failRebuild = true;
    h.registry.entityIds = ["switch.b", "switch.a"];
    h.registry.fullEntities["switch.a"] = { entity_id: "switch.a" };
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["switch.a"]);
    // the next pass builds it fresh and fails the same way
    await expect(h.manager.refreshDevices()).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);

    failRebuild = false;
    await expect(h.manager.refreshDevices()).resolves.toBe(true);
    expect(h.manager.devices.map((d) => d.entityId).sort()).toEqual([
      "switch.a",
      "switch.b",
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

  it("drops a standalone endpoint once the vacuum claims its entity (#498)", async () => {
    const h = makeHarness(["vacuum.robo", "sensor.vac_battery"], "vacuum.robo");
    await h.manager.refreshDevices();
    const added = h.serverNode.addDevice.mock.calls.map(
      (c) => c[0] as EntityEndpoint,
    );
    const vacuum = added.find((e) => e.entityId === "vacuum.robo");
    const battery = added.find((e) => e.entityId === "sensor.vac_battery");
    expect(battery).toBeDefined();

    // the vacuum picked the battery up once it became available
    (vacuum as unknown as { mappedEntityIds: string[] }).mappedEntityIds = [
      "sensor.vac_battery",
    ];
    await h.manager.refreshDevices();

    expect(battery?.delete).toHaveBeenCalled();
    expect(h.manager.failedEntities).toContainEqual({
      entityId: "sensor.vac_battery",
      reason: "Already exposed through vacuum.robo on this node.",
    });
  });

  it("removes an endpoint immediately when its entity leaves the filter but stays in HA (#468)", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    // The filter no longer matches light.b, but HA still has the entity:
    // a deliberate edit, so no grace. close() keeps the number reserved.
    h.registry.entityIds = ["light.a"];
    legacyCreate.mockClear();
    await h.manager.refreshDevices();

    expect(endpointB?.close).toHaveBeenCalledTimes(1);
    expect(endpointB?.delete).not.toHaveBeenCalled();
    expect(h.serverNode.forgetDevice).toHaveBeenCalledWith(endpointB);
    expect(legacyCreate).not.toHaveBeenCalled();
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.a"]);
  });

  it("deletes endpoints whose entity left HA, but only past the grace (#438)", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    delete h.registry.fullEntities["light.b"];
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
    delete h.registry.fullEntities["light.b"];
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

  it("a second refresh waits for the first instead of building the device again", async () => {
    const h = makeHarness(["light.a"], "light.a");
    let release!: () => void;
    h.serverNode.addDevice.mockImplementationOnce(
      () => new Promise<void>((r) => (release = r)),
    );
    const first = h.manager.refreshDevices();
    const second = h.manager.refreshDevices();
    await vi.waitFor(() =>
      expect(h.serverNode.addDevice).toHaveBeenCalledTimes(1),
    );
    expect(h.registry.refresh).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);
    expect(h.registry.refresh).toHaveBeenCalledTimes(2);
    expect(legacyCreate).toHaveBeenCalledTimes(1);
    expect(h.manager.devices).toHaveLength(1);
    expect(h.manager.failedEntities).toEqual([]);
  });

  it("a failed refresh does not block the next one", async () => {
    const h = makeHarness(["light.a"], "light.a");
    h.registry.refresh.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(h.manager.refreshDevices()).rejects.toThrow("boom");
    await h.manager.refreshDevices();
    expect(h.manager.devices).toHaveLength(1);
  });

  it("fans state updates out to every endpoint after merging states", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpoints = h.serverNode.addDevice.mock.calls.map(
      (c) => c[0] as EntityEndpoint,
    );

    const states = { "light.a": { state: "on" } } as never;
    await h.manager.updateStates(states);

    expect(h.registry.mergeExternalStates).toHaveBeenCalledWith(states, null);
    for (const endpoint of endpoints) {
      expect(endpoint.updateStates).toHaveBeenCalledWith(states);
    }
  });

  it("a same-device sensor state retriggers battery mapping (#450)", async () => {
    vacuumCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          deviceType: 0x74,
        }) as unknown as ServerModeVacuumEndpoint,
    );
    const h = makeHarness(["vacuum.robo"], "vacuum.robo", {
      entities: {
        "vacuum.robo": { device_id: "dev450" },
        "sensor.robo_battery": { device_id: "dev450" },
      },
    });
    await h.manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: the retry only runs while observing
    (h.manager as any).observingRequested = true;

    const refresh = vi
      .spyOn(h.manager, "refreshDevices")
      .mockResolvedValue(true);
    h.registry.batteryFingerprintFor.mockReturnValue("sensor.robo_battery");
    await h.manager.updateStates({
      "sensor.robo_battery": { state: "85" },
    } as never);
    await new Promise((r) => setTimeout(r, 50));

    expect(h.registry.forgetBatteryCacheForDevice).toHaveBeenCalledWith(
      "dev450",
    );
    expect(refresh).toHaveBeenCalled();
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

    // gone for one refresh, the grace stamp is set. The rename removed the
    // old id from HA's registry too, only the new id remains.
    h.registry.entityIds = [];
    delete h.registry.fullEntities["light.old"];
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
    delete h.registry.fullEntities["light.b"];
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

  it("a disabled entity keeps its endpoint id reserved (#438)", async () => {
    const h = makeHarness(["light.one", "light.two"], "light.one");
    await h.manager.refreshDevices();
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one" ? { disabled: true } : undefined,
    );
    await h.manager.refreshDevices();

    // light.two now claims the disabled entity's id: its number is parked
    // there, so the mount has to be refused instead of inheriting it.
    legacyCreate.mockImplementation(
      async (_registry, entityId) =>
        fakeEndpoint(entityId as string, {
          id: "light_one",
        }) as unknown as LegacyEndpoint,
    );
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one" ? { disabled: true } : { customName: "light one" },
    );
    await h.manager.refreshDevices();

    expect(h.manager.failedEntities.map((f) => f.entityId)).toContain(
      "light.two",
    );
  });

  it("reserves a disabled entity's id even when it starts disabled (#438)", async () => {
    // Restart with the mapping already disabled: nothing was ever closed in
    // this process, but the number is still parked in Matter storage.
    const h = makeHarness(["light.one", "light.two"], "light.one");
    // light.two carries a custom name that resolves to the same endpoint id
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one" ? { disabled: true } : { customName: "light one" },
    );
    await h.manager.refreshDevices();

    expect(h.manager.failedEntities.map((f) => f.entityId)).toContain(
      "light.two",
    );
  });

  it("moves the reservation when a disabled entity is renamed (#438)", async () => {
    const h = makeHarness(["light.one", "light.two"], "light.one");
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one" ? { disabled: true } : undefined,
    );
    await h.manager.refreshDevices();

    // The disabled entity gets a custom name, so its id moves.
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one"
        ? { disabled: true, customName: "elsewhere" }
        : undefined,
    );
    await h.manager.refreshDevices();

    // light.two may now take the id the disabled entity left behind.
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one"
        ? { disabled: true, customName: "elsewhere" }
        : { customName: "light one" },
    );
    await h.manager.refreshDevices();

    expect(h.manager.devices.map((d) => d.entityId)).toContain("light.two");
  });

  it("releases the old reservation when a re-enable also renames (#438)", async () => {
    const h = makeHarness(["light.one"], "light.one");
    h.mappingStorage.getMapping.mockReturnValue({ disabled: true });
    await h.manager.refreshDevices();
    // biome-ignore lint/suspicious/noExplicitAny: reach the private reservations
    const parked = (h.manager as any).parkedEndpointIds as Map<string, string>;
    expect([...parked.keys()]).toEqual(["light_one"]);

    // Re-enabled under a new name: it mounts elsewhere, so the old id must
    // stop blocking other entities.
    h.mappingStorage.getMapping.mockReturnValue({ customName: "elsewhere" });
    await h.manager.refreshDevices();

    expect([...parked.keys()]).toEqual([]);
  });

  it("keeps the id parked when the re-enable fails to mount (#438)", async () => {
    const h = makeHarness(["light.one", "light.two"], "light.one");
    await h.manager.refreshDevices();
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.one" ? { disabled: true } : undefined,
    );
    await h.manager.refreshDevices();

    // Re-enabled, but the mount fails.
    h.mappingStorage.getMapping.mockReturnValue(undefined);
    h.serverNode.addDevice.mockRejectedValueOnce(new Error("mount failed"));
    await h.manager.refreshDevices();

    // light.two must still not be allowed onto the parked id.
    h.mappingStorage.getMapping.mockImplementation((_b: string, e: string) =>
      e === "light.two" ? { customName: "light one" } : undefined,
    );
    h.registry.entityIds = ["light.two"];
    await h.manager.refreshDevices();
    expect(h.manager.failedEntities.map((f) => f.entityId)).toContain(
      "light.two",
    );
  });

  it("a stop during a refresh leaves no recheck timer behind (#438)", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();

    h.registry.entityIds = ["light.a"];
    // The bridge stops while the refresh is still running.
    h.registry.firstEntityMatching.mockImplementationOnce(() => {
      h.manager.stopObserving();
      return "light.a";
    });
    await h.manager.refreshDevices();

    // biome-ignore lint/suspicious/noExplicitAny: reach the private timer
    expect((h.manager as any).removalRecheckTimer).toBeNull();
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
    delete h.registry.fullEntities["light.b"];
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
    delete h.registry.fullEntities["light.b"];
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

  it("removes the last endpoint immediately when the filter empties but HA keeps the entity (#468)", async () => {
    const h = makeHarness(["light.a"]);
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    // The filter matches nothing, but HA still has the entity: a deliberate
    // edit, so no grace. close() keeps the number reserved.
    h.registry.entityIds = [];
    await h.manager.refreshDevices();

    expect(ep.close).toHaveBeenCalledTimes(1);
    expect(ep.delete).not.toHaveBeenCalled();
    expect(h.serverNode.forgetDevice).toHaveBeenCalledWith(ep);
  });

  it("holds the grace when the filter empties and the entity left HA too (#438)", async () => {
    const h = makeHarness(["light.a"], undefined, {
      entities: { "light.unrelated": {} },
    });
    await h.manager.refreshDevices();
    const ep = h.serverNode.addDevice.mock.calls[0][0] as EntityEndpoint;

    h.registry.entityIds = [];
    delete h.registry.fullEntities["light.a"];
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
