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
import { ControllerBehavior, EndpointNumber, VendorId } from "@matter/main";
import { OnOff } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import {
  FabricManager,
  Read,
  SessionManager,
  Subscribe,
} from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// #545: the per fabric line after "Device list changed" may only claim what
// the bridge observes, checked against a real controller over loopback.

const BRIDGE_ID = "bridge-545";

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
}

class FakeMappingStorage {
  getMapping(): EntityMappingConfig | undefined {
    return undefined;
  }
  getMappingsForBridge() {
    return [];
  }
  markMappingMissing() {}
  clearMappingMissing() {}
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

function addLight(ha: FakeHa, id: string) {
  ha.entities[id] = { entity_id: id };
  ha.states[id] = {
    entity_id: id,
    state: "on",
    attributes: { friendly_name: id, supported_color_modes: ["onoff"] },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
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
  addLight(ha, "light.one");
  addLight(ha, "light.two");
  return ha;
}

let dir: string;
let server: ServerNode | undefined;
let manager: BridgeEndpointManager | undefined;
let ctl: ServerNode | undefined;
const logs: string[] = [];

async function startBridge(ha: FakeHa) {
  const provider = new BridgeDataProvider({
    id: BRIDGE_ID,
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
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", join(dir, "bridge"));
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
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "bem545-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  const registry = new BridgeRegistry(ha as any, provider);
  manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {}, haRunning: true, runningSince: 0 } as any,
    registry,
    new FakeMappingStorage() as unknown as EntityMappingStorage,
    new FakeIdentityStorage() as unknown as EntityIdentityStorage,
    provider.id,
    {
      info: (...a: unknown[]) => logs.push(a.join(" ")),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  );
  await server.add(manager.root);
  await manager.refreshDevices();
  return manager;
}

async function stopBridge() {
  await manager?.dispose().catch(() => {});
  await server?.close().catch(() => {});
  manager = undefined;
  server = undefined;
}

async function commission() {
  // the operational port is only bound once the node runs
  await server?.start();
  // biome-ignore lint/suspicious/noExplicitAny: network state is loosely typed
  const port = (server?.state as any).network.operationalPort as number;
  const cenv = new Environment("ctl", Environment.default);
  cenv.get(VariableService).set("storage.path", join(dir, "ctl"));
  ctl = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: cenv as any,
      id: "ctl",
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await ctl.start();
  const client = await ctl.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: "bem545",
    D: 3840,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: descriptor is loosely typed
  } as any);
  await client.commission({
    passcode: 20202021,
    discriminator: 3840,
    autoSubscribe: false,
    autoStateInitialize: false,
  });
  return client;
}

async function subscribe(
  client: Awaited<ReturnType<typeof commission>>,
  req: Subscribe,
) {
  let reports = 0;
  // biome-ignore lint/suspicious/noExplicitAny: loose client api
  req.updated = async (data: any) => {
    for await (const chunk of data) reports += [...chunk].length;
  };
  await client.interaction.subscribe(req);
  await vi.waitFor(() => expect(reports).toBeGreaterThan(0), {
    timeout: 20_000,
  });
}

async function fabricLineAfterAdd(ha: FakeHa, bem: BridgeEndpointManager) {
  logs.length = 0;
  addLight(ha, "light.new");
  await bem.refreshDevices();
  const lines = logs.filter((l) => l.startsWith("Controller fabric"));
  expect(lines).toHaveLength(1);
  return lines[0];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bem545-"));
  logs.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // the bridge goes first, a closing controller would otherwise wait on it
  await stopBridge();
  await ctl?.close().catch(() => {});
  ctl = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("controller fabric line (#545)", () => {
  it(
    "reports when a wildcard subscriber was last heard and nothing about the device list",
    {
      timeout: 60_000,
    },
    async () => {
      const ha = makeHa();
      const bem = await startBridge(ha);
      const client = await commission();
      await subscribe(
        client,
        Subscribe({ keepSubscriptions: true, attributes: [{}] }),
      );

      const line = await fabricLineAfterAdd(ha, bem);
      expect(line).toMatch(
        /^Controller fabric 1 \(vendor 0xfff1\): 1 session, 1 subscription \(sub# [0-9a-f]{8}\), last heard \d+ s ago$/,
      );
    },
  );

  it(
    "flags a subscription that does not select the device list",
    {
      timeout: 60_000,
    },
    async () => {
      const ha = makeHa();
      const bem = await startBridge(ha);
      const client = await commission();
      const light = [...bem.root.parts].find((p) => p.id === "light_one");
      await subscribe(
        client,
        Subscribe(
          { keepSubscriptions: true },
          Read.Attribute({
            endpoint: EndpointNumber(light?.number ?? 0),
            cluster: OnOff.Complete,
            attributes: ["onOff"],
          }),
        ),
      );

      const line = await fabricLineAfterAdd(ha, bem);
      expect(line).toMatch(
        /^Controller fabric 1 \(vendor 0xfff1\): 1 session, 1 subscription \(sub# [0-9a-f]{8}\), last heard \d+ s ago, device list not in its subscription$/,
      );
    },
  );

  it("judges silence on the subscribed session only", async () => {
    const ha = makeHa();
    const bem = await startBridge(ha);
    const env = bem.root.env;
    const maybeGet = env.maybeGet.bind(env);
    vi.spyOn(env, "maybeGet").mockImplementation(((type: unknown) => {
      if (type === FabricManager) {
        return { fabrics: [{ fabricIndex: 1, rootVendorId: 0xfff1 }] };
      }
      if (type === SessionManager) {
        return {
          sessions: [
            {
              fabric: { fabricIndex: 1 },
              activeTimestamp: Time.nowUs - 600_000,
              subscriptions: new Set([
                {
                  subscriptionId: 0x1a2b,
                  maxInterval: 60_000,
                  request: { attributeRequests: [{}] },
                },
              ]),
            },
            {
              fabric: { fabricIndex: 1 },
              activeTimestamp: Time.nowUs,
              subscriptions: new Set(),
            },
          ],
        };
      }
      return maybeGet(type as Parameters<typeof maybeGet>[0]);
    }) as typeof env.maybeGet);

    const line = await fabricLineAfterAdd(ha, bem);
    expect(line).toBe(
      "Controller fabric 1 (vendor 0xfff1): 2 sessions, 1 subscription (sub# 00001a2b), last heard 10 min ago, silent past its report interval",
    );
  });
});
