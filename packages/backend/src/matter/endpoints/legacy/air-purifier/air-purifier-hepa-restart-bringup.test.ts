import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataNamespace } from "@matter/general";
import { Environment, StorageService, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ResourceMonitoring } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CustomStorage } from "../../../../core/app/storage/custom-storage.js";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ComposedAirPurifierEndpoint } from "../../composed/composed-air-purifier-endpoint.js";
import { updateEntityState } from "../../update-entity-state.js";
import { AirPurifierEndpoint } from "./index.js";

// Condition cannot be null and is not persisted, so a start with the filter
// sensor unavailable used to report a new filter (100 / Ok).

let dir: string;
let env: Environment;
let filterLife: number | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-hepa-restart-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  filterLife = null;
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {} } as any);
  env.set(EntityStateProvider, {
    getNumericState: () => filterLife,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
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
    } as any),
  );
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  const storageService = env.get(StorageService);
  storageService.registerDriver({
    id: CustomStorage.driverId,
    async create(namespace: DataNamespace) {
      const driver = new CustomStorage(namespace);
      await driver.initialize();
      return driver;
    },
  });
  storageService.defaultDriver = CustomStorage.driverId;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function purifierState(value: string, percentage: number) {
  return {
    entity_id: "fan.purifier",
    state: value,
    attributes: {
      friendly_name: "Purifier",
      supported_features: 1,
      percentage,
      percentage_step: 1,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: `2026-01-01T00:00:0${percentage % 10}`,
  };
}

const mapping = { entityId: "fan.purifier", filterLifeEntity: "sensor.filter" };

async function mount(
  variant: "flat" | "composed",
  value = "on",
  percentage = 40,
) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "hepa-restart-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const state = purifierState(value, percentage);
  let purifier: Endpoint;
  if (variant === "flat") {
    purifier = new Endpoint(
      AirPurifierEndpoint({
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        entity: { entity_id: "fan.purifier", state: state as any },
        mapping,
      } as never),
      { id: "purifier" },
    );
    await aggregator.add(purifier);
  } else {
    const composed = await ComposedAirPurifierEndpoint.create({
      registry: {
        initialState: () => state,
        entity: () => undefined,
        deviceOf: () => undefined,
      } as never,
      primaryEntityId: "fan.purifier",
      mapping,
    });
    await aggregator.add(composed!);
    purifier = [...composed!.parts][0];
  }
  return { server, purifier };
}

async function start() {
  const { server, purifier } = await mount("flat");
  const { condition, changeIndication } = purifier.stateOf(
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    "hepaFilterMonitoring" as any,
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
  ) as any;
  await server.close().catch(() => {});
  return { condition, changeIndication };
}

describe("HEPA condition across a restart", () => {
  it("keeps the last known condition when filter life is unknown at start", async () => {
    filterLife = 15;
    const first = await start();
    filterLife = null;
    const second = await start();

    expect(first).toEqual({
      condition: 15,
      changeIndication: ResourceMonitoring.ChangeIndication.Warning,
    });
    expect(second).toEqual(first);
  });

  it("reports a new filter when nothing was ever known", async () => {
    const first = await start();

    expect(first).toEqual({
      condition: 100,
      changeIndication: ResourceMonitoring.ChangeIndication.Ok,
    });
  });
});

// The fan and HEPA reactors both run on one HA change. Sharing a lock between
// them wedged the change transaction, so the purifier stopped following HA.
describe("HEPA purifier follows live HA updates", () => {
  it.each([
    "flat",
    "composed",
  ] as const)("applies fan and filter changes, then closes (%s)", async (variant) => {
    filterLife = 50;
    const { server, purifier } = await mount(variant, "off", 0);

    filterLife = 30;
    const push = updateEntityState(
      purifier,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      purifierState("on", 70) as any,
    );
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const read = (cluster: string) => purifier.stateOf(cluster as any) as any;
    await expect
      .poll(() => [
        read("onOff").onOff,
        read("fanControl").percentSetting,
        read("hepaFilterMonitoring").condition,
      ])
      .toEqual([true, 70, 30]);
    await push;
    await server.close();
  }, 15_000);
});
