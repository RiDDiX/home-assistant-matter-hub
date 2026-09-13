import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityInformation,
  LightDeviceColorMode,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #477: a light that ran above 6800K persisted 135 mireds. After a restart the
// physical range starts at its 147-500 default again, and matter.js rejected
// coupleColorTempToLevelMinMireds (147) for lying above the persisted current
// value, so the endpoint never loaded ("Behaviors have errors").

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-477-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
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

function coolWhiteLight(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "light.office",
    state: "on",
    attributes: {
      supported_color_modes: [LightDeviceColorMode.COLOR_TEMP],
      color_mode: LightDeviceColorMode.COLOR_TEMP,
      color_temp_kelvin: 7400,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 9000,
      friendly_name: "Office",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "light.office", state: state as any };
}

describe("color temperature persisted below the default minimum (#477)", () => {
  it("loads with the range widened around the persisted value", async () => {
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "node477",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(
      LightDevice({ entity: coolWhiteLight() } as never),
      {
        id: "office",
        // what a previous run left in storage
        colorControl: {
          colorTemperatureMireds: 135,
          startUpColorTemperatureMireds: 135,
        },
      } as never,
    );
    await aggregator.add(endpoint);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const cc = (endpoint.state as any).colorControl;
    expect(cc.colorTempPhysicalMinMireds).toBeLessThanOrEqual(135);
    expect(cc.coupleColorTempToLevelMinMireds).toBeLessThanOrEqual(
      cc.colorTemperatureMireds,
    );
    expect(Math.round(cc.colorTemperatureMireds)).toBe(135);
    await server.close();
  });
});
