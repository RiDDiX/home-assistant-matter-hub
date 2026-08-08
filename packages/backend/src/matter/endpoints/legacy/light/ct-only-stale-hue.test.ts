import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// A Hue color-temp-only light persisted currentHue under matter.js 0.16.x
// (which wrote no __features__ marker). After the 0.17.0 bump the cluster has
// no HueSaturation feature, so the stale value fails conformance and the
// endpoint will not add. The fix clears it on init (#370).

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-370-"));
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

function ctEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "light.floor_lamp",
    state: "off",
    attributes: {
      supported_color_modes: [LightDeviceColorMode.COLOR_TEMP],
      color_mode: null,
      color_temp_kelvin: null,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6535,
      friendly_name: "Floor Lamp",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "light.floor_lamp", state: state as any };
}

// Seed a 0.16.x-style persisted currentHue with no __features__ marker.
function seedStaleHue() {
  const base = join(dir, "node370");
  const prefix = "root.parts.aggregator.parts.lamp.colorControl.";
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, `${prefix}currentHue`), JSON.stringify(200));
  writeFileSync(join(base, `${prefix}currentSaturation`), JSON.stringify(100));
  writeFileSync(
    join(base, "root.parts.aggregator.parts.lamp.__number__"),
    JSON.stringify(2),
  );
}

async function bringUp() {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "node370",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LightDevice({ entity: ctEntity() } as never), {
    id: "lamp",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

describe("CT-only light with stale persisted hue (#370)", () => {
  it("adds without the HS conformance error and clears the stale hue", async () => {
    seedStaleHue();
    const { server, endpoint } = await bringUp();
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const cc = (endpoint.state as any).colorControl;
    expect(cc.currentHue).toBeUndefined();
    expect(cc.currentSaturation).toBeUndefined();
    expect(cc.colorTemperatureMireds).toBeDefined();
    await server.close();
  });
});
