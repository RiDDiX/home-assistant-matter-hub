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
}

function makeHa(): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
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

function makeProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-445",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "vacuum.*" }],
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

async function buildManager(ha: FakeHa) {
  const provider = makeProvider();
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
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {} } as any,
    registry,
    new FakeMappingStorage() as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    fakeLogger(),
  );
  managers.push(manager);
  await server.add(manager.root);
  return { manager, registry };
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
