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

// #452: an rgb-only light (WLED) mounted as ExtendedColorLight without the
// ColorTemperature feature, a CT-only light without Xy. Both are mandatory
// for device type 0x010d, and Alexa drops non-conformant endpoints (#182
// class). The full mandatory set must always ride along.

let dir: string;
let env: Environment;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-452-"));
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

function lightEntity(
  colorModes: LightDeviceColorMode[],
  colorMode: LightDeviceColorMode | null,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "light.strip",
    state: "off",
    attributes: {
      supported_color_modes: colorModes,
      color_mode: colorMode,
      friendly_name: "Strip",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "light.strip", state: state as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `node452-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LightDevice({ entity } as never), {
    id: "strip",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

describe("extended color light mandatory features (#452)", () => {
  it("an rgb-only light still advertises ColorTemperature and Xy", async () => {
    const { server, endpoint } = await mount(
      lightEntity([LightDeviceColorMode.RGB], LightDeviceColorMode.RGB),
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const cc = (endpoint.state as any).colorControl;
    expect(cc.featureMap.colorTemperature).toBe(true);
    expect(cc.featureMap.xy).toBe(true);
    expect(cc.featureMap.hueSaturation).toBe(true);
    expect(cc.colorTempPhysicalMinMireds).toBeGreaterThan(0);
    expect(cc.colorTemperatureMireds).toBeGreaterThanOrEqual(
      cc.colorTempPhysicalMinMireds,
    );
    await server.close();
  });

  it("a ct-only light still advertises Xy", async () => {
    const { server, endpoint } = await mount(
      lightEntity([LightDeviceColorMode.COLOR_TEMP], null),
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const cc = (endpoint.state as any).colorControl;
    expect(cc.featureMap.colorTemperature).toBe(true);
    expect(cc.featureMap.xy).toBe(true);
    await server.close();
  });
});
