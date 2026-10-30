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

// Exercise the real matter.js native operationalError emitter and completion codes.

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let fault = "none";

beforeEach(() => {
  fault = "none";
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
    getState: () => ({ state: fault }),
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
  const type = createLegacyEndpointType(vacuum("docked"), {
    entityId: "vacuum.robot",
    faultEntity: "sensor.robot_error",
  });
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

function operationalState(endpoint: Endpoint): number {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  return (endpoint.state as any).rvcOperationalState.operationalState;
}

function errorState(endpoint: Endpoint) {
  return (
    endpoint.state as unknown as {
      rvcOperationalState: {
        operationalError: RvcOperationalState.ErrorStateStruct;
      };
    }
  ).rvcOperationalState.operationalError;
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

describe("native vacuum operational errors", () => {
  it.each([
    ["no_dustbin", 66],
    ["robot_trapped", 65],
    ["main_brush_jammed", 77],
    ["wheels_jammed", 76],
    ["lidar_blocked", 78],
    ["low_battery", 72],
  ] as const)("sends %s in both native events and completion", async (cause, code) => {
    const endpoint = await mount();
    const done = completions(endpoint);
    const errors: number[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: subscribe to real behavior events
    (endpoint.events as any).rvcOperationalState.operationalError.on(
      (payload: { errorState: { errorStateId: number } }) =>
        errors.push(payload.errorState.errorStateId),
    );
    await haState(endpoint, "cleaning");
    fault = cause;
    await haState(endpoint, "error");
    expect(errors).toEqual([code]);
    expect(done).toEqual([code]);
    expect(errorState(endpoint).errorStateDetails).toContain(`[${cause}]`);
    expect(errorState(endpoint).errorStateLabel).toBeUndefined();
    await haState(endpoint, "docked");
    expect(errorState(endpoint)).toEqual({ errorStateId: 0 });
  });

  it("does not emit an operational fault for a normal low-battery return or offline state", async () => {
    const endpoint = await mount();
    const errors: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: subscribe to real behavior events
    (endpoint.events as any).rvcOperationalState.operationalError.on(
      (payload: unknown) => errors.push(payload),
    );
    fault = "low_battery";
    await haState(endpoint, "cleaning");
    await haState(endpoint, "returning");
    expect(operationalState(endpoint)).toBe(OperationalState.SeekingCharger);
    await haState(endpoint, "unavailable");
    expect(errors).toEqual([]);
  });
});
