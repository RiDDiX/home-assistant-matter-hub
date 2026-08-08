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

// #380: 0x010F is a Matter 1.4 type. The spec mandates the OnOff Lighting
// feature and recommends the 0x010A plug subset in the DeviceTypeList so
// pre-1.4 controllers fall back to a plug instead of an unknown type.

const MOUNTED = 0x010f;
const PLUG = 0x010a;
const BRIDGED_NODE = 0x0013;

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-mounted-380-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
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
    entity_id: "switch.test",
    state: "off",
    attributes: { friendly_name: "Switch" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "switch.test", state: state as any };
}

describe("mounted on/off control (#380)", () => {
  it("lists 0x010F plus the 0x010A plug fallback and the Lighting feature", async () => {
    const type = createLegacyEndpointType(switchEntity(), {
      entityId: "switch.test",
      matterDeviceType: "mounted_on_off_control",
    });
    if (!type) {
      throw new Error("no endpoint type");
    }
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "mounted-380-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(type, { id: "sw" });
    await aggregator.add(endpoint);

    let entries: Array<{ deviceType: number; revision: number }> = [];
    let lighting = false;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read runtime state
      const a = agent as any;
      entries = (
        a.descriptor.state.deviceTypeList as Array<{
          deviceType: number;
          revision: number;
        }>
      ).map((d) => ({
        deviceType: Number(d.deviceType),
        revision: Number(d.revision),
      }));
      lighting = a.onOff.state.featureMap.lighting === true;
    });
    await server.close().catch(() => {});

    const types = entries.map((e) => e.deviceType);
    expect(entries).toContainEqual({ deviceType: MOUNTED, revision: 2 });
    expect(entries).toContainEqual({ deviceType: PLUG, revision: 4 });
    // The bridged marker must survive the explicit list.
    expect(types).toContain(BRIDGED_NODE);
    expect(lighting).toBe(true);
  });
});
