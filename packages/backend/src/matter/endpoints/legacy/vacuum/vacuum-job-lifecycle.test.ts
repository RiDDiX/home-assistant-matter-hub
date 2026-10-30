// Exercise the actual endpoint behaviors and a commissioned local Matter subscription.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, Endpoint, VendorId } from "@matter/main";
import {
  Descriptor,
  PowerSource,
  RvcOperationalState,
} from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Read, Subscribe } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ServerModeVacuumEndpoint } from "../../server-mode-vacuum-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";
import { ServerModeVacuumDevice } from "./server-mode-vacuum-device.js";

let env: Environment;
let dir: string;
let server: ServerNode | undefined;
let controller: ServerNode | undefined;
let serial = 0;
let battery: number;
let job: string;
let fault: string;
let actions: unknown[];

const VAC = "vacuum.robot";
const sources = {
  jobEntity: "binary_sensor.job",
  statusEntity: "sensor.status",
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
function entity(state: string): HomeAssistantEntityInformation {
  return {
    entity_id: VAC,
    state: {
      entity_id: VAC,
      state,
      attributes: { supported_features: 0, battery_level: battery },
      context: { id: "test" },
      last_changed: "2026-01-01T00:00:00Z",
      last_updated: new Date().toISOString(),
    },
  } as HomeAssistantEntityInformation;
}

beforeEach(() => {
  battery = 50;
  job = "off";
  fault = "none";
  actions = [];
  dir = mkdtempSync(join(tmpdir(), "hamh-native-features-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call: (action: unknown) => actions.push(action),
  } as never);
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as never);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "test",
      name: "test",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "test",
        productName: "test",
        productLabel: "test",
        hardwareVersion: 1,
        softwareVersion: 1,
      },
    } as never),
  );
  env.set(EntityStateProvider, {
    getState(id: string) {
      const state =
        id === sources.jobEntity
          ? job
          : id === "sensor.fault"
            ? fault
            : id === sources.statusEntity
              ? "charging"
              : "unknown";
      return { state, attributes: { unit_of_measurement: "h" } };
    },
    getBatteryPercent: () => battery,
  } as never);
});

afterEach(async () => {
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(initial = "docked", withJob = true) {
  const ha = {
    entity: entity(initial),
    mapping: {
      entityId: VAC,
      faultEntity: "sensor.fault",
      cleaningJobEntity: withJob ? sources.jobEntity : undefined,
      chargingStateEntity: sources.statusEntity,
    },
  };
  const base = ServerModeVacuumDevice(ha)!;
  return attach(new Endpoint(base, { id: "vacuum" }));
}

async function attach(endpoint: Endpoint) {
  server = await ServerNode.create({
    environment: env as never,
    id: `native-${serial++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint);
  await pause();
  return endpoint;
}

function state(endpoint: Endpoint) {
  // biome-ignore lint/suspicious/noExplicitAny: read concrete runtime cluster states
  return endpoint.state as any;
}
async function update(endpoint: Endpoint, raw: string) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: entity(raw),
  });
  await pause();
}

describe("vacuum job lifecycle against real Matter validation", () => {
  it(
    "delivers low-battery return before the docked charging pause over a commissioned Matter subscription",
    { timeout: 60_000 },
    async () => {
      const endpoint = await mount();
      await server!.start();
      // biome-ignore lint/suspicious/noExplicitAny: runtime operational port
      const port = (server!.state as any).network.operationalPort;
      controller = await ServerNode.create(
        ServerNode.RootEndpoint.with(ControllerBehavior),
        {
          environment: env as never,
          id: `controller-${serial++}`,
          network: { port: 0 },
          basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
        },
      );
      await controller.start();
      const client = await controller.peers.forDescriptor({
        addresses: [{ type: "udp", ip: "127.0.0.1", port }],
        deviceIdentifier: "native-features",
        D: 3840,
        CM: 1,
      } as never);
      await client.commission({
        passcode: 20202021,
        discriminator: 3840,
        autoSubscribe: false,
        autoStateInitialize: false,
      });
      const seen: { cluster: number; attr: number; value: unknown }[] = [];
      const request = Subscribe(
        { keepSubscriptions: true },
        Read.Attribute({
          endpoint: endpoint.number!,
          cluster: Descriptor.Complete,
        }),
        Read.Attribute({
          endpoint: endpoint.number!,
          cluster: RvcOperationalState.Complete,
        }),
      );
      // biome-ignore lint/suspicious/noExplicitAny: streaming subscription API
      (request as any).updated = async (data: AsyncIterable<any[]>) => {
        for await (const chunk of data)
          for (const report of chunk)
            if (report.kind === "attr-value") {
              seen.push({
                cluster: Number(report.path.clusterId),
                attr: Number(report.path.attributeId),
                value: report.value,
              });
            }
      };
      const sub = await client.interaction.subscribe(request);
      try {
        const waitFor = async (
          predicate: (item: (typeof seen)[number]) => boolean,
        ) => {
          const deadline = Date.now() + 4000;
          while (!seen.some(predicate) && Date.now() < deadline) await pause();
          expect(seen.some(predicate)).toBe(true);
        };
        await waitFor(
          (item) =>
            item.cluster === 0x1d &&
            item.attr === 1 &&
            Array.isArray(item.value),
        );
        const clusters = seen.find(
          (item) => item.cluster === 0x1d && item.attr === 1,
        )!.value as number[];
        expect(clusters).not.toContain(0x71);
        expect(clusters).not.toContain(0x72);
        expect(clusters).toContain(0x61);
        job = "on";
        battery = 19;
        await update(endpoint, "cleaning");
        await waitFor(
          (item) =>
            item.cluster === 0x61 && item.attr === 4 && item.value === 1,
        );
        seen.length = 0;
        await update(endpoint, "returning");
        await waitFor(
          (item) =>
            item.cluster === 0x61 && item.attr === 4 && item.value === 64,
        );
        await waitFor(
          (item) =>
            item.cluster === 0x61 && item.attr === 1 && item.value === 2,
        );
        expect(
          state(endpoint).rvcOperationalState.operationalError.errorStateId,
        ).toBe(0);
        expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
        seen.length = 0;
        await update(endpoint, "docked");
        await waitFor(
          (item) =>
            item.cluster === 0x61 && item.attr === 4 && item.value === 2,
        );
        await waitFor(
          (item) =>
            item.cluster === 0x61 && item.attr === 1 && item.value === 1,
        );
        expect(
          state(endpoint).rvcOperationalState.operationalError.errorStateId,
        ).toBe(0);
        expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
        expect(actions).toEqual([]);
      } finally {
        sub.close();
      }
    },
  );

  it("keeps recharge paused in the same run and completes exactly once at the real return", async () => {
    const endpoint = await mount();
    const done: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: subscribe to actual matter.js events
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: { completionErrorCode: number }) =>
        done.push(event.completionErrorCode),
    );
    job = "on";
    await update(endpoint, "cleaning");
    await update(endpoint, "returning");
    await update(endpoint, "docked");
    expect(done).toEqual([]);
    expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(2);
    expect(state(endpoint).rvcOperationalState.currentPhase).toBe(1);
    expect(state(endpoint).rvcOperationalState.operationalError).toEqual({
      errorStateId: 0,
    });
    await update(endpoint, "cleaning");
    job = "off";
    await update(endpoint, "returning");
    expect(done).toEqual([0]);
    expect(state(endpoint).rvcOperationalState.currentPhase).toBe(2);
    await update(endpoint, "docked");
    expect(done).toEqual([0]);
    expect(actions).toEqual([]);
  });

  it.each([
    ["robot_trapped", 65],
  ] as const)("emits the actual standard %s fault with no forbidden label", async (cause, code) => {
    const endpoint = await mount();
    const errors: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: subscribe to real native events
    (endpoint.events as any).rvcOperationalState.operationalError.on(
      (event: { errorState: { errorStateId: number } }) =>
        errors.push(event.errorState.errorStateId),
    );
    job = "on";
    await update(endpoint, "cleaning");
    fault = cause;
    await update(endpoint, "error");
    expect(errors).toEqual([code]);
    expect(
      state(endpoint).rvcOperationalState.operationalError.errorStateId,
    ).toBe(code);
    expect(
      state(endpoint).rvcOperationalState.operationalError.errorStateLabel,
    ).toBeUndefined();
    fault = "none";
    job = "off";
    await update(endpoint, "docked");
    expect(state(endpoint).rvcOperationalState.operationalError).toEqual({
      errorStateId: 0,
    });
    expect(actions).toEqual([]);
  });

  it.each([
    0, 10, 19, 20, 21,
  ])("reports return then docked pause at %s percent without errors or completion", async (percent) => {
    const endpoint = await mount();
    const errors: number[] = [];
    const done: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: native events
    (endpoint.events as any).rvcOperationalState.operationalError.on(
      (event: { errorState: { errorStateId: number } }) =>
        errors.push(event.errorState.errorStateId),
    );
    // biome-ignore lint/suspicious/noExplicitAny: native events
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: { completionErrorCode: number }) =>
        done.push(event.completionErrorCode),
    );
    job = "on";
    battery = percent;
    await update(endpoint, "cleaning");
    await update(endpoint, "returning");
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(64);
    expect(state(endpoint).rvcOperationalState.currentPhase).toBe(2);
    expect(
      state(endpoint).rvcOperationalState.operationalError.errorStateId,
    ).toBe(0);
    expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
    expect(done).toEqual([]);
    await update(endpoint, "docked");
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(2);
    expect(state(endpoint).rvcOperationalState.currentPhase).toBe(1);
    expect(
      state(endpoint).rvcOperationalState.operationalError.errorStateId,
    ).toBe(0);
    expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
    expect(errors).toEqual([]);
    expect(done).toEqual([]);
    battery = 80;
    await update(endpoint, "cleaning");
    job = "off";
    await update(endpoint, "returning");
    expect(done).toEqual([0]);
    await update(endpoint, "docked");
    expect(done).toEqual([0]);
    expect(actions).toEqual([]);
  });

  it("reports native Warning/Critical battery levels and full charge without inventing battery faults", async () => {
    battery = 20;
    const endpoint = await mount();
    expect(state(endpoint).powerSource.batChargeLevel).toBe(
      PowerSource.BatChargeLevel.Warning,
    );
    battery = 10;
    await update(endpoint, "docked");
    expect(state(endpoint).powerSource.batChargeLevel).toBe(
      PowerSource.BatChargeLevel.Critical,
    );
    expect(
      state(endpoint).rvcOperationalState.operationalError.errorStateId,
    ).toBe(0);
    battery = 100;
    await update(endpoint, "docked");
    expect(state(endpoint).powerSource.batChargeState).toBe(
      PowerSource.BatChargeState.IsAtFullCharge,
    );
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(66);
  });
});

describe("job sensor availability", () => {
  it("does not finish a known job when its sensor becomes unknown or the robot goes offline", async () => {
    const endpoint = await mount();
    const done: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: actual optional event
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: unknown) => done.push(event),
    );
    job = "on";
    await update(endpoint, "cleaning");
    job = "unknown";
    await update(endpoint, "docked");
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(2);
    expect(state(endpoint).rvcRunMode.currentMode).toBe(1);
    await update(endpoint, "unavailable");
    expect(done).toEqual([]);
  });
  it("recognizes a job already recharging at startup and completes it once", async () => {
    job = "on";
    const endpoint = await mount();
    expect(state(endpoint).rvcOperationalState.operationalState).toBe(2);
    const done: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: actual optional event
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: unknown) => done.push(event),
    );
    job = "off";
    await update(endpoint, "returning");
    await update(endpoint, "docked");
    expect(done).toHaveLength(1);
  });
  it("keeps the existing completion fallback for a vacuum without a job sensor", async () => {
    const endpoint = await mount("docked", false);
    const done: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: actual optional event
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: unknown) => done.push(event),
    );
    await update(endpoint, "cleaning");
    await update(endpoint, "returning");
    expect(done).toEqual([]);
    await update(endpoint, "docked");
    expect(done).toHaveLength(1);
  });
});

describe.each([
  ["bridge", LegacyEndpoint],
  ["server", ServerModeVacuumEndpoint],
] as const)("%s mode mapped-only job update", (_name, Factory) => {
  it("finishes while already returning when only the unexported job sensor changes", async () => {
    const entities = Object.fromEntries(
      [VAC, sources.jobEntity].map((id) => [
        id,
        {
          entity_id: id,
          device_id: "robot",
          platform: "roborock",
          unique_id: id,
          id,
          translation_key: id === sources.jobEntity ? "cleaning" : undefined,
          categories: {},
          has_entity_name: false,
          original_name: id,
        } as HomeAssistantEntityRegistry,
      ]),
    );
    const states: Record<
      string,
      HomeAssistantEntityState<{ rooms?: Record<string, string> }>
    > = {
      [VAC]: {
        ...entity("docked").state,
        attributes: {
          ...entity("docked").state.attributes,
          rooms: { "1": "Test room" },
        },
      },
      [sources.jobEntity]: {
        ...entity("docked").state,
        entity_id: sources.jobEntity,
        state: "off",
        attributes: {},
      },
    };
    const configured = { entityId: VAC, customName: "Test robot" };
    const registry = new BridgeRegistry(
      {
        entities,
        states,
        areas: new Map(),
        devices: { robot: { id: "robot", name: "Robot" } },
        labels: [],
      } as unknown as HomeAssistantRegistry,
      new BridgeDataProvider({
        id: "test",
        name: "test",
        port: 0,
        filter: {
          include: [{ type: "pattern", value: VAC }],
          exclude: [],
          includeMode: "any",
        },
        featureFlags: {},
      } as never),
    );
    const endpoint = await Factory.create(registry, VAC, configured);
    if (!endpoint) throw new Error("No vacuum endpoint");
    expect(configured).not.toHaveProperty("cleaningJobEntity");
    expect(registry.entityIds).toEqual([VAC]);
    expect(endpoint.mappedEntityIds).toContain(sources.jobEntity);
    await attach(endpoint);
    const done: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: actual optional event
    (endpoint.events as any).rvcOperationalState.operationCompletion.on(
      (event: unknown) => done.push(event),
    );
    job = "on";
    states[sources.jobEntity] = { ...states[sources.jobEntity], state: job };
    states[VAC] = { ...states[VAC], state: "cleaning" };
    await endpoint.updateStates(states);
    await new Promise((resolve) => setTimeout(resolve, 150));
    states[VAC] = { ...states[VAC], state: "returning" };
    await endpoint.updateStates(states);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(done).toEqual([]);
    const vacuumUnchanged = states[VAC];
    job = "off";
    states[sources.jobEntity] = { ...states[sources.jobEntity], state: job };
    await endpoint.updateStates(states);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(states[VAC]).toBe(vacuumUnchanged);
    expect(done).toHaveLength(1);
    states[VAC] = { ...states[VAC], state: "docked" };
    await endpoint.updateStates(states);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(done).toHaveLength(1);
    expect(registry.entityIds).toEqual([VAC]);
    expect(actions).toEqual([]);
  });
});
