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
import { LockDevice } from "./index.js";

// A DoorLock must advertise supportedOperatingModes with the mandatory
// AlwaysSet bits (5-15) all set; matter.js rejects any other value.
// This brings the real lock endpoint online and checks the wire value (#spec).

let dir: string;
let env: Environment;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-"));
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

function lockEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "lock.front_door",
    state: "locked",
    attributes: { friendly_name: "Front Door" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door", state: state as any };
}

describe("door lock supportedOperatingModes (matter spec)", () => {
  it("brings the lock online with the mandatory alwaysSet bits set", async () => {
    const server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "lock-node",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    const aggregator = new AggregatorEndpoint("aggregator");
    await server.add(aggregator);
    const endpoint = new Endpoint(
      LockDevice({ entity: lockEntity() } as never),
      { id: "lock" },
    );
    await aggregator.add(endpoint);

    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const dl = (endpoint.state as any).doorLock;
    expect(dl.supportedOperatingModes.alwaysSet).toBe(2047);
    await server.close();
  });
});
