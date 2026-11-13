import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EntityMappingConfig,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import {
  Environment,
  type Logger,
  Time,
  VariableService,
} from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { FabricManager, SessionManager } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import { VacuumAreaSwitchEndpoint } from "../../matter/endpoints/legacy/vacuum/vacuum-area-switch.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import {
  BridgeEndpointManager,
  ENDPOINT_REMOVAL_GRACE_MS,
  removalDue,
  selectsPartsList,
} from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// #468: an entity dropped by a filter edit is a deliberate removal, not an HA
// outage, so it must leave the bridge on the very next refresh instead of
// riding the #438 grace window. An entity that vanished from HA itself still
// gets the grace.

const VACUUM = "vacuum.robot";
const OTHER = "vacuum.other";

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
  markRefreshIncomplete: ReturnType<typeof vi.fn>;
}

function makeHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
    markRefreshIncomplete: vi.fn(),
  };
  for (const id of [VACUUM, OTHER]) {
    ha.entities[id] = { entity_id: id };
    ha.states[id] = {
      entity_id: id,
      state: "docked",
      attributes: { friendly_name: id, supported_features: 4 },
      context: { id: "ctx" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: "2026-01-01T00:00:00",
    };
  }
  return ha;
}

function waitingLines(log: Logger): string[] {
  return vi
    .mocked(log.info)
    .mock.calls.map((c) => String(c[0]))
    .filter((line) => line.startsWith("No state in Home Assistant yet"));
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

let dir: string;
let seq = 0;
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

function makeProvider(patterns: string[]): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-468",
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

function setFilter(provider: BridgeDataProvider, patterns: string[]) {
  provider.update({
    id: "bridge-468",
    filter: {
      include: patterns.map((value) => ({
        type: HomeAssistantMatcherType.Pattern,
        value,
      })),
      exclude: [],
      includeMode: "any",
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial update is enough
  } as any);
}

async function buildManager(ha: FakeHa, patterns: string[] = ["vacuum.*"]) {
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
    id: `bem468-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const client = { connection: {}, haRunning: true, runningSince: 0 };
  const mapping = new FakeMappingStorage();
  const log = fakeLogger();
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    client as any,
    registry,
    mapping as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    log,
  );
  managers.push(manager);
  await server.add(manager.root);
  return { manager, provider, mapping, log, registry };
}

function switchNumbers(manager: BridgeEndpointManager): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of manager.root.parts) {
    if (p instanceof VacuumAreaSwitchEndpoint) out[p.id] = p.number;
  }
  return out;
}

function mountedEntityIds(manager: BridgeEndpointManager): string[] {
  return [...manager.root.parts]
    .map((p) => (p as EntityEndpoint).entityId)
    .filter((id): id is string => id != null)
    .sort();
}

function pending(manager: BridgeEndpointManager): Map<string, unknown> {
  // biome-ignore lint/suspicious/noExplicitAny: reach the private grace map
  return (manager as any).pendingRemovals as Map<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem468-"));
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

describe("filter edits reconcile without the grace window (#468)", () => {
  it("removes an endpoint on the next refresh when the filter stops matching", async () => {
    const ha = makeHa();
    const { manager, provider } = await buildManager(ha);
    await manager.refreshDevices();
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());

    setFilter(provider, ["vacuum.other"]);
    await manager.refreshDevices();

    expect(mountedEntityIds(manager)).toEqual([OTHER]);
    expect(pending(manager).size).toBe(0);
  });

  it("logs one line when the mounted device list moves and none when it does not (#505)", async () => {
    const ha = makeHa();
    const { manager, provider, log } = await buildManager(ha);
    const changes = () =>
      vi
        .mocked(log.info)
        .mock.calls.map((c) => String(c[0]))
        .filter((m) => m.startsWith("Device list changed"));

    await manager.refreshDevices();
    expect(changes()).toEqual([
      "Device list changed: 0 removed, 2 added (vacuum_robot, vacuum_other), 2 mounted",
    ]);

    await manager.refreshDevices();
    expect(changes()).toHaveLength(1);

    setFilter(provider, ["vacuum.other"]);
    await manager.refreshDevices();
    // one out, one in: counts alone would miss it
    setFilter(provider, ["vacuum.robot"]);
    await manager.refreshDevices();
    expect(changes().slice(1)).toEqual([
      "Device list changed: 1 removed, 0 added, 1 mounted",
      "Device list changed: 1 removed, 1 added (vacuum_robot), 1 mounted",
    ]);
  });

  it("logs each controller fabric's subscriptions when a live device list moves", async () => {
    const ha = makeHa();
    const { manager, provider, log } = await buildManager(ha, ["vacuum.other"]);
    const env = manager.root.env;
    const maybeGet = env.maybeGet.bind(env);
    vi.spyOn(env, "maybeGet").mockImplementation(((type: unknown) => {
      if (type === FabricManager) {
        return {
          fabrics: [
            { fabricIndex: 2, rootVendorId: 0x6006 },
            { fabricIndex: 3, rootVendorId: 0x1349 },
            { fabricIndex: 4, rootVendorId: 0xfff1 },
          ],
        };
      }
      if (type === SessionManager) {
        const wildcard = {
          subscriptionId: 0x10,
          maxInterval: 60_000,
          request: { attributeRequests: [{}] },
        };
        // one attribute on a bridged endpoint, PartsList changes miss it
        const narrow = {
          subscriptionId: 0xabcdef01,
          maxInterval: 60_000,
          request: {
            attributeRequests: [
              { endpointId: 5, clusterId: 6, attributeId: 0 },
            ],
          },
        };
        return {
          sessions: [
            {
              fabric: { fabricIndex: 2 },
              activeTimestamp: Time.nowUs - 3_000,
              subscriptions: new Set([
                wildcard,
                { ...wildcard, subscriptionId: 0x11 },
              ]),
            },
            { fabric: undefined, subscriptions: new Set() },
            {
              fabric: { fabricIndex: 4 },
              activeTimestamp: Time.nowUs - 600_000,
              subscriptions: new Set([narrow]),
            },
          ],
        };
      }
      return maybeGet(type as Parameters<typeof maybeGet>[0]);
    }) as typeof env.maybeGet);
    const fabricLines = () =>
      vi
        .mocked(log.info)
        .mock.calls.map((c) => String(c[0]))
        .filter((m) => m.startsWith("Controller fabric"));

    await manager.refreshDevices();
    expect(mountedEntityIds(manager)).toEqual([OTHER]);
    expect(fabricLines()).toEqual([]);

    setFilter(provider, ["vacuum.*"]);
    await manager.refreshDevices();
    expect(fabricLines()).toEqual([
      // a stalled run may read 4 s or more
      expect.stringMatching(
        /^Controller fabric 2 \(google 0x6006\): 1 session, 2 subscriptions \(sub# 00000010, 00000011\), last heard \d+ s ago$/,
      ),
      "Controller fabric 3 (apple 0x1349): 0 sessions, 0 subscriptions, not subscribed, it sees the new device list when it subscribes again",
      "Controller fabric 4 (vendor 0xfff1): 1 session, 1 subscription (sub# abcdef01), last heard 10 min ago, silent past its report interval, device list not in its subscription",
    ]);
  });

  it("selects the device list only through a PartsList path on the root or the aggregator", () => {
    const parts = { clusterId: 0x1d, attributeId: 3 };
    expect(selectsPartsList([{}], 1)).toBe(true);
    expect(selectsPartsList([{ endpointId: 0, ...parts }], 1)).toBe(true);
    expect(selectsPartsList([{ endpointId: 1, clusterId: 0x1d }], 1)).toBe(
      true,
    );
    expect(selectsPartsList([{ attributeId: 3 }], 1)).toBe(true);
    expect(selectsPartsList([{ endpointId: 2, ...parts }], 1)).toBe(false);
    expect(selectsPartsList([{ endpointId: 0, clusterId: 6 }], 1)).toBe(false);
    expect(
      selectsPartsList([{ endpointId: 0, clusterId: 0x1d, attributeId: 0 }], 1),
    ).toBe(false);
    expect(selectsPartsList(undefined, 1)).toBe(false);
  });

  it("removes only after the grace, HA uptime and a newer snapshot", () => {
    const grace = ENDPOINT_REMOVAL_GRACE_MS;
    const now = 10 * grace;
    const entry = { since: now - grace, generation: 4 };
    expect(removalDue(entry, now, now - grace, 5)).toBe(true);
    expect(removalDue({ ...entry, since: now - grace + 1 }, now, 0, 5)).toBe(
      false,
    );
    expect(removalDue(entry, now, now - grace + 1, 5)).toBe(false);
    expect(removalDue(entry, now, 0, 4)).toBe(false);
  });

  it("logs the entities newly waiting for a state in one line per pass", async () => {
    const ha = makeHa();
    delete ha.states[VACUUM];
    for (let i = 1; i <= 6; i++) {
      ha.entities[`vacuum.n${i}`] = { entity_id: `vacuum.n${i}` };
    }
    const { manager, log } = await buildManager(ha);

    await manager.refreshDevices();
    expect(waitingLines(log)).toEqual([
      `No state in Home Assistant yet for 7 matched entities, they are added once they have one: ${VACUUM}, vacuum.n1, vacuum.n2, vacuum.n3, vacuum.n4 and 2 more`,
    ]);

    ha.entities["vacuum.late"] = { entity_id: "vacuum.late" };
    await manager.refreshDevices();
    expect(waitingLines(log)).toHaveLength(2);
    expect(waitingLines(log)[1]).toBe(
      "No state in Home Assistant yet for 1 matched entity, it is added once it has one: vacuum.late",
    );
    expect(manager.failedEntities).toHaveLength(8);
  });

  it("lists a matched entity without an HA state once and mounts it when the state lands", async () => {
    const ha = makeHa();
    const state = ha.states[VACUUM];
    delete ha.states[VACUUM];
    const { manager, log } = await buildManager(ha);

    await expect(manager.refreshDevices()).resolves.toBe(true);
    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER]);
    expect(manager.failedEntities.map((f) => [f.entityId, f.reason])).toEqual([
      [VACUUM, "No state in Home Assistant yet"],
    ]);
    expect(waitingLines(log)).toEqual([
      `No state in Home Assistant yet for 1 matched entity, it is added once it has one: ${VACUUM}`,
    ]);

    ha.states[VACUUM] = state;
    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
    expect(manager.failedEntities).toEqual([]);
  });

  it("reports a refresh with a failed add as incomplete and arms the registry retry until a later one mounts it", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    const add = manager.root.add.bind(manager.root);
    vi.spyOn(manager.root, "add")
      .mockRejectedValueOnce(new Error("add failed"))
      .mockImplementation(add);

    await expect(manager.refreshDevices()).resolves.toBe(false);
    expect(mountedEntityIds(manager)).toHaveLength(1);
    expect(ha.markRefreshIncomplete).toHaveBeenCalledTimes(1);

    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
    expect(ha.markRefreshIncomplete).toHaveBeenCalledTimes(1);
  });

  it("arms the registry retry when the refresh itself throws", async () => {
    const ha = makeHa();
    const { manager, registry } = await buildManager(ha);
    vi.spyOn(registry, "refresh").mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(manager.refreshDevices()).rejects.toThrow("boom");
    expect(ha.markRefreshIncomplete).toHaveBeenCalledTimes(1);

    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(ha.markRefreshIncomplete).toHaveBeenCalledTimes(1);
  });

  it("reports a refresh with a failed create as incomplete until a later one mounts it", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    vi.spyOn(LegacyEndpoint, "create").mockRejectedValueOnce(
      new Error("create failed"),
    );

    await expect(manager.refreshDevices()).resolves.toBe(false);
    expect(mountedEntityIds(manager)).toHaveLength(1);

    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
  });

  it("warns once for a create that keeps failing", async () => {
    const ha = makeHa();
    const { manager, log } = await buildManager(ha);
    const create = LegacyEndpoint.create.bind(LegacyEndpoint);
    vi.spyOn(LegacyEndpoint, "create").mockImplementation(
      async (...args: Parameters<typeof LegacyEndpoint.create>) => {
        if (args[1] === VACUUM) throw new Error("create failed");
        return create(...args);
      },
    );
    const lines = (level: "warn" | "debug") =>
      vi
        .mocked(log[level])
        .mock.calls.filter((c) =>
          String(c[0]).startsWith(`Failed to create device ${VACUUM}`),
        );

    for (let i = 0; i < 3; i++) {
      await expect(manager.refreshDevices()).resolves.toBe(false);
    }
    expect(lines("warn")).toHaveLength(1);
    expect(lines("debug")).toHaveLength(2);
    expect(mountedEntityIds(manager)).toEqual([OTHER]);
  });

  it("stops marking a refresh incomplete after three failures with one reason", async () => {
    const ha = makeHa();
    const { manager, log } = await buildManager(ha);
    const create = LegacyEndpoint.create.bind(LegacyEndpoint);
    let reason: string | undefined = "create failed";
    vi.spyOn(LegacyEndpoint, "create").mockImplementation(
      async (...args: Parameters<typeof LegacyEndpoint.create>) => {
        if (args[1] === VACUUM && reason) throw new Error(reason);
        return create(...args);
      },
    );
    const failed = () => manager.failedEntities.map((f) => f.entityId);
    const warns = () =>
      vi
        .mocked(log.warn)
        .mock.calls.filter((c) =>
          String(c[0]).startsWith(`Failed to create device ${VACUUM}`),
        );

    for (let i = 0; i < 3; i++) {
      await expect(manager.refreshDevices()).resolves.toBe(false);
    }
    for (let i = 0; i < 2; i++) {
      await expect(manager.refreshDevices()).resolves.toBe(true);
      expect(failed()).toEqual([VACUUM]);
    }
    expect(warns()).toHaveLength(1);

    reason = "another reason";
    await expect(manager.refreshDevices()).resolves.toBe(false);
    expect(warns()).toHaveLength(2);

    reason = undefined;
    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());

    // a success starts the count over
    reason = "create failed";
    vi.mocked(log.warn).mockClear();
    const robot = [...manager.root.parts].find(
      (p) => (p as EntityEndpoint).entityId === VACUUM,
    );
    await robot?.close();
    await expect(manager.refreshDevices()).resolves.toBe(false);
    expect(warns()).toHaveLength(1);
  });

  it("logs an add that keeps failing in full once and stops marking it incomplete", async () => {
    const ha = makeHa();
    const { manager, log } = await buildManager(ha);
    const add = manager.root.add.bind(manager.root);
    vi.spyOn(manager.root, "add").mockImplementation(((ep: EntityEndpoint) => {
      if (ep.entityId === VACUUM) throw new Error("add failed");
      return add(ep);
    }) as typeof manager.root.add);
    const lines = (level: "warn" | "debug") =>
      vi
        .mocked(log[level])
        .mock.calls.filter((c) =>
          String(c[0]).startsWith(`Failed to add endpoint for ${VACUUM}`),
        );

    for (let i = 0; i < 3; i++) {
      await expect(manager.refreshDevices()).resolves.toBe(false);
    }
    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect(manager.failedEntities.map((f) => f.entityId)).toEqual([VACUUM]);
    expect(lines("warn")).toHaveLength(1);
    expect(lines("debug")).toHaveLength(3);
  });

  it("logs a failure in full again after the entity left the bridge and came back", async () => {
    const ha = makeHa();
    const { manager, provider, log } = await buildManager(ha);
    const create = LegacyEndpoint.create.bind(LegacyEndpoint);
    vi.spyOn(LegacyEndpoint, "create").mockImplementation(
      async (...args: Parameters<typeof LegacyEndpoint.create>) => {
        if (args[1] === VACUUM) throw new Error("create failed");
        return create(...args);
      },
    );
    const warns = () =>
      vi
        .mocked(log.warn)
        .mock.calls.filter((c) =>
          String(c[0]).startsWith(`Failed to create device ${VACUUM}`),
        );

    await manager.refreshDevices();
    setFilter(provider, ["vacuum.other"]);
    await manager.refreshDevices();
    setFilter(provider, ["vacuum.*"]);
    await expect(manager.refreshDevices()).resolves.toBe(false);
    expect(warns()).toHaveLength(2);
  });

  it("reports each queued refresh by its own outcome", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    const add = manager.root.add.bind(manager.root);
    vi.spyOn(manager.root, "add")
      .mockRejectedValueOnce(new Error("add failed"))
      .mockImplementation(add);

    const first = manager.refreshDevices();
    const second = manager.refreshDevices();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
  });

  it("keeps the grace window for an entity that vanished from HA itself", async () => {
    const ha = makeHa();
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();

    delete ha.entities[VACUUM];
    delete ha.states[VACUUM];
    await manager.refreshDevices();

    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
    expect(pending(manager).has(VACUUM)).toBe(true);
  });

  it("re-including the entity mounts it again under the same endpoint number", async () => {
    const ha = makeHa();
    const { manager, provider } = await buildManager(ha);
    await manager.refreshDevices();
    const before = [...manager.root.parts].find(
      (p) => (p as EntityEndpoint).entityId === VACUUM,
    )?.number;

    setFilter(provider, ["vacuum.other"]);
    await manager.refreshDevices();
    expect(mountedEntityIds(manager)).toEqual([OTHER]);

    setFilter(provider, ["vacuum.*"]);
    await manager.refreshDevices();

    const after = [...manager.root.parts].find(
      (p) => (p as EntityEndpoint).entityId === VACUUM,
    )?.number;
    expect(mountedEntityIds(manager)).toEqual([OTHER, VACUUM].sort());
    expect(after).toBe(before);
  });

  it("takes a vacuum's room switches along and brings them back on their old numbers", async () => {
    const ha = makeHa();
    ha.states[VACUUM].attributes.rooms = { "16": "Kitchen", "17": "Bedroom" };
    const { manager, provider, mapping } = await buildManager(ha);
    mapping.put("bridge-468", { entityId: VACUUM, vacuumRoomSwitches: true });
    await manager.refreshDevices();
    const before = switchNumbers(manager);
    expect(Object.keys(before)).toHaveLength(2);

    setFilter(provider, ["vacuum.other"]);
    await manager.refreshDevices();
    expect(switchNumbers(manager)).toEqual({});

    setFilter(provider, ["vacuum.*"]);
    await manager.refreshDevices();
    expect(switchNumbers(manager)).toEqual(before);
  });

  it("an isolation during a refresh leaves no room switch behind", async () => {
    const ha = makeHa();
    ha.states[VACUUM].attributes.rooms = { "16": "Kitchen", "17": "Bedroom" };
    const { manager, mapping } = await buildManager(ha);
    mapping.put("bridge-468", { entityId: VACUUM, vacuumRoomSwitches: true });
    const root = manager.root;
    const add = root.add.bind(root);
    let reached!: () => void;
    const atSwitchAdd = new Promise<void>((r) => {
      reached = r;
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    vi.spyOn(root, "add").mockImplementation((async (
      ...args: Parameters<typeof add>
    ) => {
      if (first && args[0] instanceof VacuumAreaSwitchEndpoint) {
        first = false;
        reached();
        await held;
      }
      return add(...args);
    }) as typeof root.add);

    const refresh = manager.refreshDevices();
    await atSwitchAdd;
    const isolation = manager.isolateEntity(VACUUM);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([refresh, isolation]);

    expect(mountedEntityIds(manager)).toEqual([OTHER]);
    expect(switchNumbers(manager)).toEqual({});
  });
});
