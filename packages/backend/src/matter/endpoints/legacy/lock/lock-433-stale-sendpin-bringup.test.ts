import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// #433: releases v2.0.7..v2.0.16 wrote sendPinOverTheAir=true for every lock
// and matter.js persisted it. v2.0.17 turned on the User feature, which makes
// the attribute illegal (conformance [!USR & PIN]). The stored leftover then
// fails doorLock init on every start once the features key catches up, and the
// retry mints a fresh endpoint number, so Google announces a new lock each
// boot. The fix clears the resurrected value pre-initialize and thereby
// deletes the stored key for good.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock433-"));
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

function lockEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "lock.front_door_lock",
    state: "locked",
    attributes: { friendly_name: "Front Door Lock" },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door_lock", state: state as any };
}

async function mountLock() {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: makeEnv() as any,
    id: "lock433-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LockDevice({ entity: lockEntity() } as never), {
    id: "lock_front_door_lock",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

const stalePinFile = () =>
  join(
    dir,
    "lock433-node",
    "root.parts.aggregator.parts.lock_front_door_lock.doorLock.sendPinOverTheAir",
  );

describe("lock with a stale persisted sendPinOverTheAir (#433)", () => {
  it("keeps the attribute unset on a fresh mount", async () => {
    const { server, endpoint } = await mountLock();
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    expect((endpoint.state as any).doorLock.sendPinOverTheAir).toBeUndefined();
    await server.close();
  });

  it("heals the poisoned store instead of failing the endpoint", async () => {
    const first = await mountLock();
    await first.server.close();

    // What a v2.0.7..v2.0.16 run left behind. The features key already
    // matches after the first mount, so the value loads on the next start.
    writeFileSync(stalePinFile(), "true");

    const second = await mountLock();
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const dl = (second.endpoint.state as any).doorLock;
    expect(dl.sendPinOverTheAir).toBeUndefined();
    expect(dl.lockState).not.toBeUndefined();
    await second.server.close();

    expect(existsSync(stalePinFile())).toBe(false);
  });
});
