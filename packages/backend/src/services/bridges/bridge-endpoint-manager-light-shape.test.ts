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

// A light picks OnOff/Dimmable/ExtendedColor once from supported_color_modes.
// One that was unavailable at bridge start had none, mounted as OnOffLight and
// stayed that way. The shape rank is part of the fingerprint now and only an
// upgrade rebuilds.

const LIGHT = "light.desk";
const ON_OFF = 0x0100;
const EXTENDED_COLOR = 0x010d;

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

function makeHa(state: string, attributes: Record<string, unknown>): FakeHa {
  const ha: FakeHa = {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
  };
  ha.entities[LIGHT] = { entity_id: LIGHT };
  ha.states[LIGHT] = {
    entity_id: LIGHT,
    state,
    attributes: { friendly_name: "Desk", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  return ha;
}

const COLOR = {
  supported_color_modes: ["color_temp", "xy"],
  min_color_temp_kelvin: 2000,
  max_color_temp_kelvin: 6500,
  color_mode: null,
  brightness: null,
  color_temp_kelvin: null,
  xy_color: null,
  hs_color: null,
};

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
    id: "bridge-light",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "light.*" }],
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
    id: `bemlight-node-${seq++}`,
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

function lightEndpoint(manager: BridgeEndpointManager): EntityEndpoint {
  const ep = [...manager.root.parts].find(
    (p) => (p as EntityEndpoint).entityId === LIGHT,
  );
  if (!ep) throw new Error("light endpoint not mounted");
  return ep as EntityEndpoint;
}

function deviceType(ep: EntityEndpoint): number {
  // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  return (ep.state as any).descriptor.deviceTypeList[0].deviceType;
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
  dir = mkdtempSync(join(tmpdir(), "hamh-bemlight-"));
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

async function observe(manager: BridgeEndpointManager) {
  // the retry only runs while observing; the deferred refresh must not dial
  // the fake connection
  // biome-ignore lint/suspicious/noExplicitAny: drive the private hook
  (manager as any).observingRequested = true;
  vi.spyOn(manager, "startObserving").mockResolvedValue(undefined);
}

async function settled(manager: BridgeEndpointManager) {
  await new Promise((r) => setTimeout(r, 50));
  // biome-ignore lint/suspicious/noExplicitAny: reach the retry flag
  await until(() => !(manager as any).mappingSync.retryPending);
}

describe("light shape rebuild", () => {
  it("upgrades a light mounted unavailable, never downgrades it", async () => {
    const ha = makeHa("unavailable", {});
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = lightEndpoint(manager);
    expect(deviceType(first)).toBe(ON_OFF);
    await observe(manager);

    ha.states[LIGHT].state = "off";
    ha.states[LIGHT].attributes = { friendly_name: "Desk", ...COLOR };
    await manager.updateStates(ha.states, new Set([LIGHT]));
    await until(() => lightEndpoint(manager) !== first);
    await settled(manager);

    const rebuilt = lightEndpoint(manager);
    expect(rebuilt).not.toBe(first);
    expect(deviceType(rebuilt)).toBe(EXTENDED_COLOR);
    // same endpoint id and number so controllers keep the device (#404)
    expect(rebuilt.id).toBe(first.id);
    expect(rebuilt.number).toBe(first.number);

    // a group whose members dropped out reports fewer modes
    const refresh = vi.spyOn(manager, "refreshDevices");
    ha.states[LIGHT].attributes = {
      friendly_name: "Desk",
      supported_color_modes: ["onoff"],
    };
    await manager.updateStates(ha.states, new Set([LIGHT]));
    await settled(manager);
    expect(refresh).not.toHaveBeenCalled();
    registry.refresh();
    await manager.refreshDevices();
    expect(lightEndpoint(manager)).toBe(rebuilt);

    // unavailable with stripped attributes
    ha.states[LIGHT].state = "unavailable";
    ha.states[LIGHT].attributes = { friendly_name: "Desk" };
    await manager.updateStates(ha.states, new Set([LIGHT]));
    await settled(manager);
    registry.refresh();
    await manager.refreshDevices();
    expect(lightEndpoint(manager)).toBe(rebuilt);
    expect(deviceType(lightEndpoint(manager))).toBe(EXTENDED_COLOR);
  });

  it("an on/off light that stays on/off never rebuilds", async () => {
    const ha = makeHa("off", { supported_color_modes: ["onoff"] });
    const { manager, registry } = await buildManager(ha);
    await manager.refreshDevices();
    const first = lightEndpoint(manager);
    expect(deviceType(first)).toBe(ON_OFF);
    await observe(manager);
    const refresh = vi.spyOn(manager, "refreshDevices");

    ha.states[LIGHT].state = "on";
    await manager.updateStates(ha.states, new Set([LIGHT]));
    ha.states[LIGHT].state = "unavailable";
    ha.states[LIGHT].attributes = { friendly_name: "Desk" };
    await manager.updateStates(ha.states, new Set([LIGHT]));
    ha.states[LIGHT].state = "off";
    ha.states[LIGHT].attributes = {
      friendly_name: "Desk",
      supported_color_modes: ["onoff"],
    };
    await manager.updateStates(ha.states, new Set([LIGHT]));
    await settled(manager);
    expect(refresh).not.toHaveBeenCalled();
    registry.refresh();
    await manager.refreshDevices();
    expect(lightEndpoint(manager)).toBe(first);
  });
});
