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
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// matter.js refuses PumpConfigurationAndControl without a control mode
// feature, so a switch mapped as pump never mounted.

let dir: string;
let env: Environment;
let calls: Array<{ action: HomeAssistantAction; entityId: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-pump-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction, entityId: string) {
      calls.push({ action, entityId });
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function switchEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "switch.pump",
    state: "off",
    attributes: { friendly_name: "Pump" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "switch.pump", state: state as any };
}

describe("switch mapped as pump", () => {
  it("mounts and forwards On to HA", async () => {
    const type = createLegacyEndpointType(switchEntity(), {
      entityId: "switch.pump",
      matterDeviceType: "pump",
    });
    if (!type) {
      throw new Error("no endpoint type");
    }
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "pump-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(type, { id: "pump" });
    await aggregator.add(endpoint);

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).onOff.on();
    });
    await server.close().catch(() => {});

    expect(calls).toContainEqual({
      action: { action: "homeassistant.turn_on" },
      entityId: "switch.pump",
    });
  });
});
