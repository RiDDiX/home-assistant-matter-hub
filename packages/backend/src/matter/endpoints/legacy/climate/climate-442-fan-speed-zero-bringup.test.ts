import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// #442: a controller writing fan speed zero on a Room AC. The fan cannot stop
// while the compressor runs, so the write must clamp to the slowest real fan
// mode and must not flip the OnOff cluster off.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-climate442-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function acEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "climate.ac",
    state: "cool",
    attributes: {
      friendly_name: "AC",
      hvac_modes: ["off", "cool"],
      min_temp: 16,
      max_temp: 30,
      temperature: 22,
      current_temperature: 24,
      // TARGET_TEMPERATURE | FAN_MODE | TURN_ON | TURN_OFF
      supported_features: 393,
      fan_modes: ["Low", "Mid", "High"],
      fan_mode: "High",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.ac", state: state as any };
}

async function speedZeroWrite(): Promise<{
  onOff: boolean | undefined;
  fanModeSent: string | undefined;
}> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "climate442-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    ClimateDevice({ entity: acEntity() } as never),
    {
      id: "ac",
    },
  );
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
    const a = agent as any;
    a.onOff.state.onOff = true; // AC is running
    a.fanControl.targetPercentSettingChanged(0, 100, { subject: {} });
  });
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const onOff = ((endpoint.state as any).onOff?.onOff ?? undefined) as
    | boolean
    | undefined;
  await server.close().catch(() => {});

  const setFanMode = calls.find((c) => c.action === "climate.set_fan_mode");
  return {
    onOff,
    fanModeSent: (setFanMode?.data as { fan_mode?: string } | undefined)
      ?.fan_mode,
  };
}

describe("climate fan speed zero on a Room AC (#442)", () => {
  it("clamps to the slowest real fan mode instead of the undeclared off", async () => {
    const result = await speedZeroWrite();
    expect(result.fanModeSent).toBe("Low");
  });

  it("keeps the OnOff cluster on, power belongs to OnOff commands", async () => {
    const result = await speedZeroWrite();
    expect(result.onOff).toBe(true);
  });
});
