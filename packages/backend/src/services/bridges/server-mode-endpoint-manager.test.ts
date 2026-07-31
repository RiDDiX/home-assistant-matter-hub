import type { Logger } from "@matter/general";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  };
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
  // biome-ignore lint/suspicious/noExplicitAny: registry stub
  const fullEntities: Record<string, any> = {};
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
  const manager = new ServerModeEndpointManager(
    serverNode as unknown as ServerModeServerNode,
    { connection: {} } as unknown as HomeAssistantClient,
    registry as unknown as BridgeRegistry,
    mappingStorage as unknown as EntityMappingStorage,
    identityStorage as unknown as EntityIdentityStorage,
    dataProvider as unknown as BridgeDataProvider,
    fakeLogger(),
  );
  return { manager, serverNode, registry, mappingStorage, dataProvider };
}

const legacyCreate = vi.mocked(LegacyEndpoint.create);
const vacuumCreate = vi.mocked(ServerModeVacuumEndpoint.create);

beforeEach(() => {
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

  it("deletes endpoints whose entity left the filter and keeps the rest", async () => {
    const h = makeHarness(["light.a", "light.b"], "light.a");
    await h.manager.refreshDevices();
    const endpointB = h.serverNode.addDevice.mock.calls
      .map((c) => c[0] as EntityEndpoint)
      .find((e) => e.entityId === "light.b");

    h.registry.entityIds = ["light.a"];
    legacyCreate.mockClear();
    await h.manager.refreshDevices();

    expect(endpointB?.delete).toHaveBeenCalledTimes(1);
    expect(h.serverNode.forgetDevice).toHaveBeenCalledWith(endpointB);
    expect(legacyCreate).not.toHaveBeenCalled();
    expect(h.manager.devices.map((d) => d.entityId)).toEqual(["light.a"]);
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

  it("keeps the disabled and empty-filter failed-entity semantics", async () => {
    const empty = makeHarness([]);
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
