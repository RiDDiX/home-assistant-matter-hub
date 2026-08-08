import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantStates } from "../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "./aggregator-endpoint.js";
import { ComposedSensorEndpoint } from "./composed/composed-sensor-endpoint.js";
import { createLegacyEndpointType } from "./legacy/create-legacy-endpoint-type.js";

// #431: PowerTopology NODE means "this measurement covers the whole node". A
// bridge is one node for every accessory, so Apple Home painted one metered
// plug's watts onto every bridged device. TREE scopes it to the endpoint.

interface FeatureMap {
  nodeTopology: boolean;
  treeTopology: boolean;
  setTopology: boolean;
  dynamicPowerFlow: boolean;
}

const POWER = "sensor.plug_power";
const TEMPERATURE = "sensor.hub_temperature";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-power-topology-431-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call() {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: (id: string) => (id === POWER ? 1500 : null),
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

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

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes: { friendly_name: entityId, ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function switchEntity(): HomeAssistantEntityInformation {
  return {
    entity_id: "switch.plug",
    state: state("switch.plug", "on"),
  };
}

async function newServer(): Promise<AggregatorEndpoint> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `power-topology-431-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  return aggregator;
}

async function featureMapOf(endpoint: Endpoint): Promise<FeatureMap> {
  let featureMap: FeatureMap | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    featureMap = a.powerTopology?.state.featureMap;
  });
  if (!featureMap) {
    throw new Error("powerTopology is not mounted on this endpoint");
  }
  return featureMap;
}

// one HA device carrying a temperature sensor and a power sensor, so the
// composed parent mounts PowerTopology above its sub-endpoints
function composedRegistry(): BridgeRegistry {
  const entities = {
    [TEMPERATURE]: { entity_id: TEMPERATURE, device_id: "dev1" },
    [POWER]: { entity_id: POWER, device_id: "dev1" },
  };
  const states: HomeAssistantStates = {
    [TEMPERATURE]: state(TEMPERATURE, "21.5", {
      device_class: "temperature",
      unit_of_measurement: "°C",
    }),
    [POWER]: state(POWER, "1500", {
      device_class: "power",
      unit_of_measurement: "W",
    }),
  };
  const registry = {
    entities,
    states,
    devices: { dev1: { id: "dev1", name: "Sensor Hub" } },
    labels: [],
    areas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  } as any;
  return new BridgeRegistry(registry, dataProvider());
}

describe("power topology scope on a bridge (#431)", () => {
  it("scopes a metered plug to its own endpoint, not the whole node", async () => {
    const type = createLegacyEndpointType(switchEntity(), {
      entityId: "switch.plug",
      powerEntity: POWER,
    });
    if (!type) {
      throw new Error("no endpoint type");
    }
    const aggregator = await newServer();
    const endpoint = new Endpoint(type, { id: "plug" });
    await aggregator.add(endpoint);

    const featureMap = await featureMapOf(endpoint);
    expect(featureMap.treeTopology).toBe(true);
    expect(featureMap.nodeTopology).toBe(false);
    // NODE/TREE/SET are a choice, and DYNPW would pull in attributes nothing
    // seeds, so the whole map has to be pinned, not just the tree bit.
    expect(featureMap.setTopology).toBe(false);
    expect(featureMap.dynamicPowerFlow).toBe(false);
  });

  it("scopes a composed sensor parent to its own subtree", async () => {
    const endpoint = await ComposedSensorEndpoint.create({
      registry: composedRegistry(),
      primaryEntityId: TEMPERATURE,
      powerEntityId: POWER,
    });
    if (!endpoint) {
      throw new Error("no composed endpoint");
    }

    const aggregator = await newServer();
    await aggregator.add(endpoint);

    const featureMap = await featureMapOf(endpoint);
    expect(featureMap.treeTopology).toBe(true);
    expect(featureMap.nodeTopology).toBe(false);
    expect(featureMap.setTopology).toBe(false);
    expect(featureMap.dynamicPowerFlow).toBe(false);
  });
});
