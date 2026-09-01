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
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
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
  return { manager, provider };
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
});
