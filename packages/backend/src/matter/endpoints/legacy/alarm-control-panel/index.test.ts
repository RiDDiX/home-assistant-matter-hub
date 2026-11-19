import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { AlarmControlPanelDevice } from "./index.js";

function description(friendlyName: string | undefined): string {
  const entity = {
    entity_id: "alarm_control_panel.home",
    state: {
      entity_id: "alarm_control_panel.home",
      state: "disarmed",
      attributes: { friendly_name: friendlyName, supported_features: 3 },
    },
  };
  const endpointType = AlarmControlPanelDevice({ entity } as never);
  // biome-ignore lint/suspicious/noExplicitAny: inspecting matter.js internals
  const behaviors = (endpointType as any).behaviors;
  return behaviors.modeSelect.defaults.description;
}

describe("AlarmControlPanelDevice ModeSelect description", () => {
  it("cuts a long name to the 64 byte limit", () => {
    const value = description("Alarm ".repeat(20));
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    expect(value.endsWith("...")).toBe(true);
  });

  it("keeps a short name and falls back without one", () => {
    expect(description("House alarm")).toBe("House alarm");
    expect(description(undefined)).toBe("Alarm Panel");
  });
});

describe("AlarmControlPanelDevice current mode", () => {
  let dir: string;
  let env: Environment;
  let server: ServerNode | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hamh-alarm-panel-"));
    env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    env.set(HomeAssistantActions, {
      call: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);
    env.set(
      BridgeDataProvider,
      new BridgeDataProvider({
        id: "b",
        name: "b",
        port: 0,
        filter: { include: [], exclude: [], includeMode: "any" },
        featureFlags: {},
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

  afterEach(async () => {
    await server?.close().catch(() => {});
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  // supported_features 3: Disarmed (0), Armed Home (1), Armed Away (2)
  const entity = (state: string) => ({
    entity_id: "alarm_control_panel.home",
    state: {
      entity_id: "alarm_control_panel.home",
      state,
      attributes: { friendly_name: "Home", supported_features: 3 },
    },
  });

  async function start(state: string) {
    server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "alarm-panel-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const type = AlarmControlPanelDevice({ entity: entity(state) } as never);
    const endpoint = new Endpoint(type!, { id: "alarm" });
    await aggregator.add(endpoint);
    return endpoint;
  }

  const currentMode = (endpoint: Endpoint) =>
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    (endpoint.state as any).modeSelect.currentMode;

  it("keeps the armed mode while triggered and then unavailable", async () => {
    const endpoint = await start("armed_away");
    expect(currentMode(endpoint)).toBe(2);
    for (const state of ["triggered", "unavailable"]) {
      await endpoint.setStateOf(HomeAssistantEntityBehavior, {
        entity: entity(state) as never,
      });
      expect(currentMode(endpoint)).toBe(2);
    }
  });

  it("starts with a valid mode when the first state is triggered", async () => {
    const endpoint = await start("triggered");
    expect(currentMode(endpoint)).toBe(0);
  });
});
