import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { RvcOperationalState } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

import OperationalState = RvcOperationalState.OperationalState;

// OperationCompletion is mandatory for the vacuum device type but optional in
// the cluster, so it was never sent.

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-rvc-done-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {} } as any);
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
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function vacuum(state: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: "vacuum.robot",
    state,
    attributes: { friendly_name: "Robot", supported_features: 0 },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "vacuum.robot", state: s as any };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount() {
  const type = createLegacyEndpointType(vacuum("docked"));
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `nrvc-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "vacuum" });
  await aggregator.add(endpoint);
  return endpoint;
}

async function haState(endpoint: Endpoint, state: string) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: vacuum(state),
  });
  await delay(40);
}

async function controllerStart(endpoint: Endpoint) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    await (agent as any).rvcRunMode.changeToMode({ newMode: 1 });
  });
}

function operationalState(endpoint: Endpoint): number {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcOperationalState.operationalState;
}

function completions(endpoint: Endpoint): number[] {
  const seen: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: behavior events
  (endpoint.events as any).rvcOperationalState.operationCompletion.on(
    (payload: { completionErrorCode: number }) =>
      seen.push(payload.completionErrorCode),
  );
  return seen;
}

describe("vacuum OperationCompletion", () => {
  it("is sent when a clean ends", async () => {
    const endpoint = await mount();
    const seen = completions(endpoint);

    await haState(endpoint, "cleaning");
    await haState(endpoint, "docked");

    expect(seen).toEqual([0]);
  });

  it("is sent once for a clean with a pause in it", async () => {
    const endpoint = await mount();
    const seen = completions(endpoint);

    await haState(endpoint, "cleaning");
    await haState(endpoint, "paused");
    await haState(endpoint, "cleaning");
    await haState(endpoint, "returning");
    await haState(endpoint, "docked");

    expect(seen).toEqual([0]);
  });

  it("is not sent when the vacuum drops offline mid-clean", async () => {
    const endpoint = await mount();
    const seen = completions(endpoint);

    await haState(endpoint, "cleaning");
    await haState(endpoint, "unavailable");

    expect(seen).toEqual([]);
  });
});

// #496: HA took 15 s to report cleaning, Apple Home read Cleaning + Docked
// as "Ready, Resume Cleaning Later" in between.
describe("vacuum controller start", () => {
  it("reports Running before HA confirms the clean", async () => {
    const endpoint = await mount();
    const seen = completions(endpoint);
    expect(operationalState(endpoint)).toBe(OperationalState.Docked);

    await controllerStart(endpoint);
    expect(operationalState(endpoint)).toBe(OperationalState.Running);

    await haState(endpoint, "cleaning");
    await haState(endpoint, "docked");
    expect(seen).toEqual([0]);
  });

  it("sends no completion when HA still reports docked", async () => {
    const endpoint = await mount();
    const seen = completions(endpoint);

    await controllerStart(endpoint);
    await haState(endpoint, "docked");

    expect(operationalState(endpoint)).toBe(OperationalState.Docked);
    expect(seen).toEqual([]);
  });
});
