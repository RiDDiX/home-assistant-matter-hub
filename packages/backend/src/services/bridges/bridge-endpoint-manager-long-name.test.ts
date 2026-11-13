import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomeAssistantMatcherType } from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { HomeAssistantActions } from "../home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../home-assistant/home-assistant-config.js";
import type { EntityIdentityStorage } from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";

// A long multi-byte custom name made the storage file name exceed 255 bytes,
// so the endpoint never mounted (ENAMETOOLONG).

const SWITCH = "switch.cjk";
const NAME = "开".repeat(60);

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
  getMapping(bridgeId: string, entityId: string) {
    return entityId === SWITCH
      ? { bridgeId, entityId, customName: NAME }
      : undefined;
  }
  getMappingsForBridge() {
    return [];
  }
  markMappingMissing() {}
  clearMappingMissing() {}
  async deleteMapping() {}
  async deleteBridgeMappings() {}
}

let dir: string;
let seq = 0;
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

function makeProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "bridge-long-name",
    name: "b",
    port: 0,
    filter: {
      include: [{ type: HomeAssistantMatcherType.Pattern, value: "switch.*" }],
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

async function buildManager() {
  const ha = {
    entities: { [SWITCH]: { entity_id: SWITCH } },
    states: {
      [SWITCH]: {
        entity_id: SWITCH,
        state: "on",
        attributes: { friendly_name: "Switch" },
        context: { id: "ctx" },
        last_changed: "2026-01-01T00:00:00",
        last_updated: "2026-01-01T00:00:00",
      },
    },
    devices: {},
    areas: new Map(),
    labels: [],
    snapshotGeneration: 1,
    markRefreshIncomplete() {},
  };
  const provider = makeProvider();
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
    id: `bemlong-node-${seq++}`,
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
    {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  );
  managers.push(manager);
  await server.add(manager.root);
  return manager;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bemlong-"));
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

describe("long multi-byte custom name", () => {
  it("mounts a switch named with 60 CJK characters", async () => {
    const manager = await buildManager();
    await manager.refreshDevices();
    const ep = [...manager.root.parts].find(
      (p) => (p as EntityEndpoint).entityId === SWITCH,
    );
    expect(ep).toBeDefined();
    expect(ep?.lifecycle.isReady).toBe(true);
    const files = readdirSync(dir, { recursive: true }) as string[];
    expect(files.some((f) => f.includes("aggregator.parts."))).toBe(true);
  });
});
