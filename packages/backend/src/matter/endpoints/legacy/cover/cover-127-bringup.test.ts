import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { CoverDevice } from "./index.js";

// #381: a cover that once had set_tilt_position persisted a tilt percent, then
// reports only tilt open/close/stop (supported_features=127, no PA_TL). On
// reboot that persisted percent is out of conformance (TL & PA_TL) and used to
// crash init and drop the cover. It must be cleared so the cover comes online.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover127-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(): Environment {
  const env = new Environment("test", Environment.default);
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
  return env;
}

function coverEntity(
  supportedFeatures: number,
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "cover.blind",
    state: "open",
    attributes: {
      friendly_name: "Blind",
      supported_features: supportedFeatures,
      current_position: 50,
      current_tilt_position: 50,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "cover.blind", state: state as any };
}

async function bringOnline(supportedFeatures: number) {
  const env = makeEnv();
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "cover127-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    CoverDevice({ entity: coverEntity(supportedFeatures) } as never),
    { id: "blind" },
  );
  // Throws (conformance rollback) when a persisted tilt percent is replayed
  // into a tilt-only cluster before the fix.
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const online = (endpoint.state as any).windowCovering.type !== undefined;
  await server.close();
  return online;
}

describe("tilt-only cover survives a persisted PA_TL tilt value (#381)", () => {
  it("reboots tilt-only after a boot that persisted a tilt percent", async () => {
    // Boot 1: full tilt with set_tilt_position (255) persists a tilt percent.
    expect(await bringOnline(255)).toBe(true);
    // Boot 2: same storage, now tilt-only (127, no set_tilt_position).
    expect(await bringOnline(127)).toBe(true);
  });
});
