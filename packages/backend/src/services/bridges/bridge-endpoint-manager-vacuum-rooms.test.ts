import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeAssistantMatcherType } from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
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

// A Dreame mounted while unavailable has no rooms attribute and gets the
// single Home area. ServiceArea is picked once at creation, so the rooms that
// arrive later must rebuild the endpoint.

const VACUUM = "vacuum.robot";
const ROOMS = {
  "Map 1": [
    { id: 6, name: "Kitchen" },
    { id: 9, name: "Office" },
    { id: 12, name: "Bedroom" },
  ],
};

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
  getMapping() {
    return undefined;
  }
  getMappingsForBridge() {
    return [];
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

function makeHa(value: string, withRooms: boolean): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  ha.entities[VACUUM] = { entity_id: VACUUM };
  ha.states[VACUUM] = vacuumState(value, withRooms);
  return ha;
}

// biome-ignore lint/suspicious/noExplicitAny: minimal state fixture
function vacuumState(value: string, withRooms: boolean): any {
  return {
    entity_id: VACUUM,
    state: value,
    attributes: {
      friendly_name: "Robot",
      supported_features: 0,
      ...(withRooms ? { rooms: ROOMS } : {}),
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
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

function makeProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-vacuum-rooms",
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
    id: `bemvac-node-${seq++}`,
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
  return { manager, registry };
}

function vacuumEndpoint(manager: BridgeEndpointManager): EntityEndpoint {
  const ep = [...manager.root.parts].find(
    (p) => (p as EntityEndpoint).entityId === VACUUM,
  );
  if (!ep) throw new Error("vacuum endpoint not mounted");
  return ep as EntityEndpoint;
}

function areaIds(ep: EntityEndpoint): number[] {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (ep.state as any).serviceArea.supportedAreas.map(
    (a: { areaId: number }) => a.areaId,
  );
}

async function until(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      if (cond()) return;
    } catch {}
    if (Date.now() - start >= ms) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bemvac-"));
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

describe("vacuum rooms rebuild", () => {
  it("rebuilds a vacuum mounted unavailable once its rooms arrive", async () => {
    const ha = makeHa("unavailable", false);
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const first = vacuumEndpoint(manager);
    expect(areaIds(first)).toEqual([1]);

    // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
    (manager as any).observingRequested = true;
    vi.spyOn(manager, "startObserving").mockResolvedValue(undefined);
    const refresh = vi.spyOn(manager, "refreshDevices");

    ha.states[VACUUM] = vacuumState("docked", true);
    await manager.updateStates(ha.states, new Set([VACUUM]));
    await until(() => vacuumEndpoint(manager) !== first);

    const rebuilt = vacuumEndpoint(manager);
    expect(rebuilt).not.toBe(first);
    // same endpoint id so matter.js keeps the persisted number (#404)
    expect(rebuilt.id).toBe(first.id);
    expect(areaIds(rebuilt)).toEqual([6, 9, 12]);
    // biome-ignore lint/suspicious/noExplicitAny: reach the retry flag
    await until(() => !(manager as any).mappingSync.retryPending);
    expect(refresh).toHaveBeenCalledTimes(1);

    // a later plain state change rebuilds nothing
    ha.states[VACUUM] = vacuumState("cleaning", true);
    await manager.updateStates(ha.states, new Set([VACUUM]));
    await new Promise((r) => setTimeout(r, 50));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(vacuumEndpoint(manager)).toBe(rebuilt);
  });

  it("a vacuum with rooms that goes unavailable and returns is not rebuilt", async () => {
    const ha = makeHa("docked", true);
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = vacuumEndpoint(manager);
    expect(areaIds(first)).toEqual([6, 9, 12]);

    // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
    (manager as any).observingRequested = true;
    vi.spyOn(manager, "startObserving").mockResolvedValue(undefined);
    const refresh = vi.spyOn(manager, "refreshDevices");

    ha.states[VACUUM] = vacuumState("unavailable", false);
    await manager.updateStates(ha.states, new Set([VACUUM]));
    registry.refresh();
    await manager.refreshDevices();
    expect(vacuumEndpoint(manager)).toBe(first);

    ha.states[VACUUM] = vacuumState("docked", true);
    await manager.updateStates(ha.states, new Set([VACUUM]));
    registry.refresh();
    await manager.refreshDevices();
    await new Promise((r) => setTimeout(r, 50));
    expect(vacuumEndpoint(manager)).toBe(first);
    // only the two direct calls above, no scheduled retry
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
