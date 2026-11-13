import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { Descriptor, OccupancySensing } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Read } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #528: Apple Home does not show occupancy sensors, Alexa does. Records what a
// controller reads for device_class occupancy versus motion.

const DEVICE = "occ-dev";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let controller: ServerNode | undefined;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sensorState(
  entityId: string,
  deviceClass: string,
  value: string,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: "Hallway", device_class: deviceClass },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  } as unknown as HomeAssistantEntityState;
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
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

function registry(state: HomeAssistantEntityState): BridgeRegistry {
  const entityId = state.entity_id;
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "Hallway" } },
    entities: {
      [entityId]: {
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
      } as unknown as HomeAssistantEntityRegistry,
    },
    labels: [],
    states: { [entityId]: state },
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-528occ-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantActions, {
    call() {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(state: HomeAssistantEntityState) {
  const endpoint = await LegacyEndpoint.create(
    registry(state),
    state.entity_id,
    { entityId: state.entity_id },
  );
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `528occ-node-${counter}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint!);
  await server.start();
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const port = (server.state as any).network.operationalPort as number;

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `528occ-controller-${counter++}`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await controller.start();
  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: `528-${counter}`,
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
  return { endpoint: endpoint!, client };
}

// Attribute values of one cluster as the controller reads them, by name.
async function remoteRead(
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  client: any,
  endpointNo: number,
  // biome-ignore lint/suspicious/noExplicitAny: any cluster
  cluster: any,
): Promise<Record<string, unknown>> {
  const names = new Map<number, string>([
    [0xfff8, "generatedCommandList"],
    [0xfff9, "acceptedCommandList"],
    [0xfffb, "attributeList"],
    [0xfffc, "featureMap"],
    [0xfffd, "clusterRevision"],
    ...Object.entries(cluster.attributes).map(
      // biome-ignore lint/suspicious/noExplicitAny: cluster attribute model
      ([name, attr]) => [Number((attr as any).id), name] as [number, string],
    ),
  ]);
  const values: Record<string, unknown> = {};
  for await (const chunk of client.interaction.read(
    Read(
      Read.Attribute({
        endpoint: endpointNo,
        cluster,
        // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
      } as any),
    ),
  )) {
    for (const r of chunk) {
      if (r.kind !== "attr-value") continue;
      const id = Number(r.path.attributeId);
      values[names.get(id) ?? `0x${id.toString(16)}`] = r.value;
    }
  }
  return values;
}

const cases = [
  {
    deviceClass: "occupancy",
    featureMap: { physicalContact: true },
    sensorType: OccupancySensing.OccupancySensorType.PhysicalContact,
    bitmap: { pir: false, physicalContact: true, ultrasonic: false },
  },
  {
    deviceClass: "motion",
    featureMap: { passiveInfrared: true },
    sensorType: OccupancySensing.OccupancySensorType.Pir,
    bitmap: { pir: true, physicalContact: false, ultrasonic: false },
  },
];

describe("occupancy vs motion on the wire (#528)", () => {
  it.each(cases)(
    "device_class $deviceClass",
    { timeout: 120_000 },
    async ({ deviceClass, featureMap, sensorType, bitmap }) => {
      const entityId = `binary_sensor.hallway_${deviceClass}`;
      const { endpoint, client } = await mount(
        sensorState(entityId, deviceClass, "on"),
      );

      const descriptor = await remoteRead(
        client,
        endpoint.number,
        Descriptor.Cluster,
      );
      const deviceTypes = (
        descriptor.deviceTypeList as Array<{ deviceType: number }>
      ).map((d) => d.deviceType);
      expect(deviceTypes).toContain(0x0107);
      expect(deviceTypes).toContain(0x0013);

      const occ = await remoteRead(
        client,
        endpoint.number,
        OccupancySensing.Complete,
      );
      console.log(`#528 ${deviceClass}`, JSON.stringify(occ));
      expect(occ.featureMap).toMatchObject(featureMap);
      expect(occ.clusterRevision).toBe(7);
      expect(occ.attributeList).toEqual([
        0, 1, 2, 0xfff8, 0xfff9, 0xfffb, 0xfffc, 0xfffd,
      ]);
      expect(occ.occupancy).toEqual({ occupied: true });
      expect(occ.occupancySensorType).toBe(sensorType);
      expect(occ.occupancySensorTypeBitmap).toEqual(bitmap);

      await endpoint.updateStates({
        [entityId]: sensorState(entityId, deviceClass, "off"),
      });
      await delay(150);
      const after = await remoteRead(
        client,
        endpoint.number,
        OccupancySensing.Complete,
      );
      expect(after.occupancy).toEqual({ occupied: false });
    },
  );
});
