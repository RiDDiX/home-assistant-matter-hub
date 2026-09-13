// A matter.js commissioner on loopback, subscribed to the vacuum's PowerSource,
// proves what a controller receives. Off by default, needs common built:
//   HAMH_LOOPBACK=1 npx vitest run subscription-loopback
// Controller = ServerNode with ControllerBehavior; forDescriptor with an
// address skips mDNS; reports arrive through request.updated (#450).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { PowerSource } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Read, Subscribe } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";

const DEVICE = "vac-dev";
const VACUUM = "vacuum.robot";
const BATTERY = "sensor.robot_battery";
const BAT_PERCENT_REMAINING = 12;
const BAT_CHARGE_STATE = 26;

let dir: string;
let env: Environment;
let device: ServerNode | undefined;
let controller: ServerNode | undefined;
let liveStates: HomeAssistantStates;

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: DEVICE,
    disabled_by: null,
    entity_category: null,
    entity_id: entityId,
    has_entity_name: false,
    hidden_by: null,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "test",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}
function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}
function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { autoBatteryMapping: true },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
}
function vacuumState(): HomeAssistantEntityState {
  return state(VACUUM, "docked", {
    supported_features: 15,
    fan_speed: "medium",
    fan_speed_list: ["off", "low", "medium", "high"],
  });
}
function batteryState(percent: number): HomeAssistantEntityState {
  return state(BATTERY, String(percent), { device_class: "battery" });
}
function makeRegistry(): BridgeRegistry {
  liveStates = { [VACUUM]: vacuumState(), [BATTERY]: batteryState(96) };
  const entities = Object.fromEntries(
    Object.keys(liveStates).map((id) => [id, registryEntity(id)]),
  );
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Robot" } },
    entities,
    labels: [],
    states: liveStates,
  } as unknown as HomeAssistantRegistry;
  env.set(EntityStateProvider, new EntityStateProvider(haRegistry));
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-loopback-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call(_a: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
});
afterEach(async () => {
  await controller?.close().catch(() => {});
  await device?.close().catch(() => {});
  controller = device = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const delay = (n: number) => new Promise((r) => setTimeout(r, n));

// biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
async function deliverBatteryOnly(endpoint: any, percent: number) {
  liveStates[BATTERY] = batteryState(percent);
  liveStates[VACUUM] = vacuumState();
  await endpoint.updateStates({ ...liveStates });
}

interface Seen {
  attr: number;
  value: unknown;
  at: number;
}

async function waitFor(
  seen: Seen[],
  pred: (s: Seen) => boolean,
  limit: number,
): Promise<Seen | undefined> {
  const start = Date.now();
  while (Date.now() - start < limit) {
    const hit = seen.find(pred);
    if (hit) return hit;
    await delay(25);
  }
  return undefined;
}

async function bringUp() {
  const reg = makeRegistry();
  const endpoint = await ServerModeVacuumEndpoint.create(reg, VACUUM);
  expect(endpoint).toBeDefined();

  device = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
    environment: env as any,
    id: "loopback-device",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  await device.add(endpoint!);
  await device.start();
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  const port = (device.state as any).network.operationalPort as number;
  expect(port).toBeGreaterThan(0);

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
      environment: env as any,
      id: "loopback-controller",
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await controller.start();

  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: "loopback",
    D: 3840,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: 20202021,
    discriminator: 3840,
    autoSubscribe: false,
    autoStateInitialize: false,
  });

  const seen: Seen[] = [];
  const req = Subscribe(
    { keepSubscriptions: true },
    Read.Attribute({
      endpoint: endpoint!.number,
      cluster: PowerSource.Complete,
    }),
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  ) as any;
  // Subscribe() does not copy options.update; the hook is request.updated
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  req.updated = async (data: any) => {
    for await (const chunk of data) {
      for (const r of chunk) {
        if (
          r.kind === "attr-value" &&
          Number(r.path.clusterId) === PowerSource.Complete.id
        ) {
          seen.push({
            attr: Number(r.path.attributeId),
            value: r.value,
            at: Date.now(),
          });
        }
      }
    }
  };
  const sub = await client.interaction.subscribe(req);
  await delay(500);
  expect(seen.find((s) => s.attr === BAT_PERCENT_REMAINING)?.value).toBe(192);
  seen.length = 0;
  return { endpoint: endpoint!, client, seen, sub };
}

describe.skipIf(!process.env.HAMH_LOOPBACK)(
  "subscription over loopback",
  () => {
    it(
      "delivers battery percentage and charge state with the write",
      { timeout: 120_000 },
      async () => {
        const { endpoint, seen, sub } = await bringUp();

        const t1 = Date.now();
        await deliverBatteryOnly(endpoint, 90);
        const hit1 = await waitFor(
          seen,
          (s) => s.attr === BAT_PERCENT_REMAINING && s.value === 180,
          15_000,
        );
        expect(hit1).toBeDefined();
        expect(hit1!.at - t1).toBeLessThan(2000);
        seen.length = 0;

        // inside the 10 s quiet window of the previous report
        const t2 = Date.now();
        await deliverBatteryOnly(endpoint, 85);
        const hit2 = await waitFor(
          seen,
          (s) => s.attr === BAT_PERCENT_REMAINING && s.value === 170,
          15_000,
        );
        expect(hit2).toBeDefined();
        expect(hit2!.at - t2).toBeLessThan(2000);
        seen.length = 0;

        liveStates[VACUUM] = state(
          VACUUM,
          "cleaning",
          vacuumState().attributes,
        );
        await endpoint.updateStates({ ...liveStates });
        const hit3 = await waitFor(
          seen,
          (s) => s.attr === BAT_CHARGE_STATE,
          15_000,
        );
        expect(hit3?.value).toBe(PowerSource.BatChargeState.IsNotCharging);
        sub.close();
      },
    );
  },
);
