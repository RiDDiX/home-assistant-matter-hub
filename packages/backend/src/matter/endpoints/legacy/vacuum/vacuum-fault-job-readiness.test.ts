// Combined 535 (fault details) + 536 (job lifecycle) + 538 (readiness) scenarios.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
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

const { OperationalState, ErrorState } = RvcOperationalState;

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
const sensors: Record<string, string> = {};
const old = new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(sensors)) delete sensors[k];
  dir = mkdtempSync(join(tmpdir(), "hamh-stack-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, { call() {} } as never);
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
      },
    } as never),
  );
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as never);
  env.set(EntityStateProvider, {
    getState: (id: string) =>
      id in sensors ? { state: sensors[id], last_changed: old } : undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
  } as never);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function vacuum(state: string): HomeAssistantEntityInformation {
  return {
    entity_id: "vacuum.robot",
    state: {
      entity_id: "vacuum.robot",
      state,
      attributes: {
        friendly_name: "Robot",
        supported_features: 0,
        battery_level: 50,
      },
      context: { id: "c" },
      last_changed: "2026-01-01T00:00:00",
      last_updated: new Date().toISOString(),
    },
  } as never;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(mapping: Partial<EntityMappingConfig>) {
  const type = createLegacyEndpointType(vacuum("docked"), {
    entityId: "vacuum.robot",
    ...mapping,
  });
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    environment: env as never,
    id: `stack-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "vacuum" });
  await aggregator.add(endpoint);
  const done: number[] = [];
  const errors: number[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: behavior events
  const ev = (endpoint.events as any).rvcOperationalState;
  ev.operationCompletion.on((p: { completionErrorCode: number }) =>
    done.push(p.completionErrorCode),
  );
  ev.operationalError.on((p: { errorState: { errorStateId: number } }) =>
    errors.push(p.errorState.errorStateId),
  );
  const ha = async (state: string, wait = 40) => {
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: vacuum(state),
    });
    await delay(wait);
  };
  const op = () =>
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    (endpoint.state as any).rvcOperationalState as {
      operationalState: number;
      operationalError: { errorStateId: number };
    };
  return { endpoint, done, errors, ha, op };
}

describe("535 + 536 + 538 stacked", () => {
  it("I1: completion keeps 535's detailed fault code (no readiness mapping)", async () => {
    sensors["sensor.err"] = "no_dustbin";
    const v = await mount({ faultEntity: "sensor.err" });
    await v.ha("cleaning");
    await v.ha("error", 650);
    expect(v.errors).toEqual([ErrorState.DustBinMissing]);
    expect(v.done).toEqual([ErrorState.DustBinMissing]);
  });

  it("I2: readiness-blocked dock is reported at once, not held by the 535 fault settle", async () => {
    sensors["sensor.err"] = "none";
    sensors["sensor.ready"] = "bin_full";
    const v = await mount({
      faultEntity: "sensor.err",
      readinessEntity: "sensor.ready",
    });
    await v.ha("cleaning");
    await v.ha("docked", 100);
    expect(v.op().operationalState).toBe(OperationalState.Error);
    expect(v.op().operationalError.errorStateId).toBe(
      ErrorState.UnableToStartOrResume,
    );
    expect(v.done).toEqual([ErrorState.NoError]);
  });

  it("I3: mid-clean recharge (job on) with a blocking readiness sensor stays Paused without an error event", async () => {
    sensors["binary_sensor.job"] = "on";
    sensors["sensor.ready"] = "bin_full";
    const v = await mount({
      cleaningJobEntity: "binary_sensor.job",
      readinessEntity: "sensor.ready",
    });
    await v.ha("cleaning");
    await v.ha("returning");
    await v.ha("docked");
    expect(v.op().operationalState).toBe(OperationalState.Paused);
    expect(v.op().operationalError.errorStateId).toBe(ErrorState.NoError);
    expect(v.errors).toEqual([]);
    expect(v.done).toEqual([]);
    sensors["binary_sensor.job"] = "off";
    await v.ha("docked");
    expect(v.done).toEqual([ErrorState.NoError]);
    expect(v.op().operationalState).toBe(OperationalState.Error);
  });

  it("I4: fault during a job completes once with the detailed code, recovery to dock does not complete again", async () => {
    sensors["binary_sensor.job"] = "on";
    sensors["sensor.err"] = "none";
    const v = await mount({
      faultEntity: "sensor.err",
      cleaningJobEntity: "binary_sensor.job",
    });
    await v.ha("cleaning");
    sensors["sensor.err"] = "wheels_jammed";
    await v.ha("error", 650);
    expect(v.done).toEqual([ErrorState.WheelsJammed]);
    sensors["sensor.err"] = "none";
    await v.ha("docked");
    sensors["binary_sensor.job"] = "off";
    await v.ha("docked");
    expect(v.done).toEqual([ErrorState.WheelsJammed]);
  });

  it("I5: unavailable is Stopped/NoError with every mapping and never completes", async () => {
    sensors["binary_sensor.job"] = "on";
    sensors["sensor.ready"] = "ready";
    const v = await mount({
      faultEntity: "sensor.err",
      cleaningJobEntity: "binary_sensor.job",
      readinessEntity: "sensor.ready",
    });
    await v.ha("cleaning");
    await v.ha("unavailable", 650);
    expect(v.op().operationalState).toBe(OperationalState.Stopped);
    expect(v.op().operationalError.errorStateId).toBe(ErrorState.NoError);
    expect(v.errors).toEqual([]);
    expect(v.done).toEqual([]);
  });
});
