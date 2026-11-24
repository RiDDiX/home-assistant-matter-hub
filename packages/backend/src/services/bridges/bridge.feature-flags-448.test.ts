import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeStatus,
  HomeAssistantMatcherType,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { HomeAssistantActions } from "../home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../home-assistant/home-assistant-config.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { Bridge } from "./bridge.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// #448: the cover conversion reads the feature flags live, but nothing ran it
// again after a flag edit. The entity set is unchanged, so the refresh mounts
// nothing, and the endpoint skips an HA state equal to the last one, so the
// attributes kept the old space until the cover moved in HA.

const COVER = "cover.blind";
const SWITCH = "switch.plug";
const T0 = "2026-01-01T00:00:00";

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

function makeHa() {
  return {
    entities: {
      [COVER]: { entity_id: COVER },
      [SWITCH]: { entity_id: SWITCH },
    },
    states: {
      [COVER]: {
        entity_id: COVER,
        state: "open",
        attributes: {
          friendly_name: "Blind",
          // open + close + set_position
          supported_features: 7,
          current_position: 80,
        },
        context: { id: "ctx" },
        last_changed: T0,
        last_updated: T0,
      },
      [SWITCH]: {
        entity_id: SWITCH,
        state: "on",
        attributes: { friendly_name: "Plug" },
        context: { id: "ctx" },
        last_changed: T0,
        last_updated: T0,
      },
    },
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
    markRefreshIncomplete() {},
  };
}

const data = {
  id: "bridge-448",
  name: "b",
  port: 0,
  filter: {
    include: [
      { type: HomeAssistantMatcherType.Pattern, value: "cover.*" },
      { type: HomeAssistantMatcherType.Pattern, value: "switch.*" },
    ],
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
  },
};

let dir: string;
let seq = 0;
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];
const builds: Promise<unknown>[] = [];

// a timed out test keeps mounting, teardown waits for it before the dir goes
function build() {
  const b = mount();
  builds.push(b.catch(() => {}));
  return b;
}

async function mount() {
  const ha = makeHa();
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  const provider = new BridgeDataProvider(structuredClone(data) as any);
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call() {},
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
    id: `bridge448-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {}, haRunning: true, runningSince: 0 } as any,
    registry,
    new FakeMappingStorage() as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );
  managers.push(manager);
  await server.add(manager.root);
  // the real constructor builds a full BridgeEnvironment, fake the rest
  const bridge = Object.create(Bridge.prototype) as Bridge;
  Object.assign(bridge, {
    log: {
      debug() {},
      debugCtx() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as Logger,
    dataProvider: provider,
    endpointManager: manager,
    server,
    status: { code: BridgeStatus.Stopped },
    lastSyncedStates: new Map(),
    autoForceSyncTimer: null,
  });
  await bridge.refreshDevices();
  return { bridge, manager };
}

// biome-ignore lint/suspicious/noExplicitAny: read cluster state
function state(manager: BridgeEndpointManager, entityId: string): any {
  const ep = [...manager.root.parts].find(
    (p) => (p as EntityEndpoint).entityId === entityId,
  );
  if (!ep) throw new Error(`${entityId} not mounted`);
  return ep.state;
}

function lift(manager: BridgeEndpointManager) {
  const wc = state(manager, COVER).windowCovering;
  return {
    current: wc.currentPositionLiftPercent100ths,
    target: wc.targetPositionLiftPercent100ths,
  };
}

function lastUpdated(manager: BridgeEndpointManager, entityId: string) {
  return state(manager, entityId).homeAssistantEntity.entity.state.last_updated;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bridge448-"));
});

afterEach(async () => {
  await Promise.all(builds.splice(0));
  for (const m of managers.splice(0)) {
    await m.dispose().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    await s.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("feature flag edit reaches existing endpoints (#448)", () => {
  it("re-applies the unchanged HA state in the new position space", async () => {
    const { bridge, manager } = await build();
    expect(lift(manager)).toEqual({ current: 2000, target: 2000 });

    await bridge.update({
      ...data,
      featureFlags: { coverUseHomeAssistantPercentage: true },
    } as unknown as UpdateBridgeRequest);
    await vi.waitFor(
      () => expect(lift(manager)).toEqual({ current: 8000, target: 8000 }),
      { timeout: 5_000, interval: 5 },
    );
    await new Promise((r) => setTimeout(r, 100));

    // a new last_updated reads as a state change elsewhere (#340)
    expect(lastUpdated(manager, SWITCH)).toBe(T0);
  }, 30_000);

  it("re-pushes nothing when the cover space stays the same", async () => {
    const { bridge, manager } = await build();

    await bridge.update({
      ...data,
      featureFlags: { fastSessionRecovery: true },
    } as unknown as UpdateBridgeRequest);
    await new Promise((r) => setTimeout(r, 100));

    expect(lastUpdated(manager, COVER)).toBe(T0);
    expect(lift(manager)).toEqual({ current: 2000, target: 2000 });
  }, 30_000);
});
