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
import { LockDevice } from "./index.js";

// #397: unbolt = bolt only (lock.unlock), unlock = bolt + latch (lock.open).
// Google's "open door when unlocking" toggle picks which command it sends.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-397-"));
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// OPEN feature, so HAMH builds the unbolt variant.
function lockEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "lock.front_door",
    state: "locked",
    attributes: { friendly_name: "Front Door", supported_features: 1 },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door", state: state as any };
}

async function invoke(
  command: "unboltDoor" | "unlockDoor",
): Promise<HomeAssistantAction | undefined> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "lock-397-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LockDevice({ entity: lockEntity() } as never), {
    id: "lock",
  });
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke the door lock command
    (agent as any).doorLock[command]({});
  });
  await server.close().catch(() => {});
  return calls[calls.length - 1];
}

describe("door lock unbolt vs unlock (#397)", () => {
  it("maps unboltDoor to lock.unlock (retract bolt, no latch)", async () => {
    const action = await invoke("unboltDoor");
    expect(action?.action).toBe("lock.unlock");
  });

  it("maps unlockDoor to lock.open (unbolt and pull latch)", async () => {
    const action = await invoke("unlockDoor");
    expect(action?.action).toBe("lock.open");
  });
});
