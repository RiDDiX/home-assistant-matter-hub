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

// #515: the fan endpoint's device type and FanControl features were computed
// once at creation and never re-evaluated. A fan that gained speed/direction
// later (LocalTuya configured after the bridge start) stayed a bare plug
// until a restart. The capability tuple is part of the fingerprint now and a
// capability change in a state batch schedules a one-shot rebuild.

const FAN = "fan.ceiling";

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

function makeHa(supportedFeatures: number): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  ha.entities[FAN] = { entity_id: FAN };
  ha.states[FAN] = {
    entity_id: FAN,
    state: "on",
    attributes: {
      friendly_name: "Ceiling",
      supported_features: supportedFeatures,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
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

function makeProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-515",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "fan.*" }],
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
    id: `bem515-node-${seq++}`,
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

function fanEndpoint(manager: BridgeEndpointManager): EntityEndpoint {
  const ep = [...manager.root.parts].find(
    (p) => (p as EntityEndpoint).entityId === FAN,
  );
  if (!ep) throw new Error("fan endpoint not mounted");
  return ep as EntityEndpoint;
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
  dir = mkdtempSync(join(tmpdir(), "hamh-bem515-"));
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

describe("fan capability rebuild (#515)", () => {
  it("rebuilds the endpoint when the fan gains speed and direction", async () => {
    // TURN_OFF | TURN_ON only: no FanControl, the fan mounts as a plug
    const ha = makeHa(48);
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const first = fanEndpoint(manager);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((first.state as any).fanControl).toBeUndefined();

    // the retry only runs while observing; the deferred refresh must not
    // dial the fake connection
    // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
    (manager as any).observingRequested = true;
    vi.spyOn(manager, "startObserving").mockResolvedValue(undefined);

    // LocalTuya configured: SET_SPEED | DIRECTION | TURN_OFF | TURN_ON
    ha.states[FAN].attributes = {
      friendly_name: "Ceiling",
      supported_features: 53,
      percentage: 33,
      percentage_step: 1,
      direction: "reverse",
    };
    await manager.updateStates(ha.states, new Set([FAN]));
    await until(() => fanEndpoint(manager) !== first);

    const rebuilt = fanEndpoint(manager);
    expect(rebuilt).not.toBe(first);
    // same endpoint id so matter.js keeps the persisted number (#404)
    expect(rebuilt.id).toBe(first.id);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const fanControl = (rebuilt.state as any).fanControl;
    expect(fanControl).toBeDefined();
    expect(fanControl.featureMap.multiSpeed).toBe(true);
    expect(fanControl.featureMap.airflowDirection).toBe(true);
    // drain the deferred refresh before teardown
    // biome-ignore lint/suspicious/noExplicitAny: reach the retry flag
    await until(() => !(manager as any).mappingSync.retryPending);
  });

  it("an unavailable flap with stripped attributes does not rebuild", async () => {
    const ha = makeHa(53);
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = fanEndpoint(manager);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((first.state as any).fanControl).toBeDefined();

    // LocalTuya drops attributes while unavailable
    ha.states[FAN].state = "unavailable";
    ha.states[FAN].attributes = { friendly_name: "Ceiling" };
    registry.refresh();
    await manager.refreshDevices();
    expect(fanEndpoint(manager)).toBe(first);
  });

  it("a plain state change schedules no rebuild", async () => {
    const ha = makeHa(53);
    const { manager } = await buildManager(ha);
    await manager.refreshDevices();
    const first = fanEndpoint(manager);

    // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
    (manager as any).observingRequested = true;
    const refresh = vi.spyOn(manager, "refreshDevices");
    ha.states[FAN].attributes = {
      ...ha.states[FAN].attributes,
      percentage: 66,
    };
    await manager.updateStates(ha.states, new Set([FAN]));
    await new Promise((r) => setTimeout(r, 50));
    expect(refresh).not.toHaveBeenCalled();
    expect(fanEndpoint(manager)).toBe(first);
  });
});
