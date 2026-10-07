import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
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

// #418: lockWithoutPin exposes the lock without User and PIN features, so a
// lock without a keypad gets no access code prompt. Locks without the flag
// keep their PIN features.

let dir: string;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-nopin-"));
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(): Environment {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
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
  return env;
}

function lockEntity(supportedFeatures: number): HomeAssistantEntityInformation {
  const state = {
    entity_id: "lock.front_door",
    state: "locked",
    attributes: {
      friendly_name: "Front Door",
      supported_features: supportedFeatures,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door", state: state as any };
}

const noPin: EntityMappingConfig = {
  entityId: "lock.front_door",
  lockWithoutPin: true,
};

async function mount(
  mapping: EntityMappingConfig | undefined,
  supportedFeatures = 0,
) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: makeEnv() as any,
    id: "lock-nopin-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    LockDevice({
      entity: lockEntity(supportedFeatures),
      mapping,
    } as never),
    { id: "lock" },
  );
  await aggregator.add(endpoint);
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const doorLock = () => (endpoint.state as any).doorLock;
  return { server, endpoint, doorLock };
}

async function command(
  endpoint: Endpoint,
  run: (doorLock: Record<string, (r?: object) => unknown>) => unknown,
): Promise<string[]> {
  calls.length = 0;
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke the door lock command
    await run((agent as any).doorLock);
  });
  return calls.map((c) => c.action);
}

describe("lockWithoutPin (#418)", () => {
  it("leaves locks without the flag on the PIN features", async () => {
    const { server, doorLock } = await mount(undefined);
    expect(doorLock().featureMap).toMatchObject({
      user: true,
      pinCredential: true,
      credentialOverTheAirAccess: true,
    });
    await server.close();
  });

  it("drops the User and PIN features and still locks and unlocks", async () => {
    const { server, endpoint, doorLock } = await mount(noPin);
    expect(doorLock().featureMap).toMatchObject({
      user: false,
      pinCredential: false,
      credentialOverTheAirAccess: false,
      unbolting: false,
    });
    expect(doorLock().requirePinForRemoteOperation).toBeUndefined();
    expect(await command(endpoint, (d) => d.lockDoor({}))).toEqual([
      "lock.lock",
    ]);
    expect(await command(endpoint, (d) => d.unlockDoor({}))).toEqual([
      "lock.unlock",
    ]);
    await server.close();
  });

  it("keeps Unbolting for locks with the OPEN feature", async () => {
    const { server, endpoint, doorLock } = await mount(noPin, 1);
    expect(doorLock().featureMap).toMatchObject({
      user: false,
      pinCredential: false,
      unbolting: true,
    });
    expect(await command(endpoint, (d) => d.unlockDoor({}))).toEqual([
      "lock.open",
    ]);
    expect(await command(endpoint, (d) => d.unboltDoor({}))).toEqual([
      "lock.unlock",
    ]);
    await server.close();
  });

  it("starts from a store written with PIN features and back", async () => {
    for (const [mapping, features] of [
      [undefined, 0],
      [noPin, 0],
      [noPin, 0],
      [undefined, 0],
      [undefined, 1],
      [noPin, 1],
      [noPin, 1],
      [undefined, 1],
    ] as const) {
      const { server, doorLock } = await mount(mapping, features);
      const fm = doorLock().featureMap;
      expect(fm.pinCredential).toBe(mapping === undefined);
      expect(fm.unbolting).toBe(features === 1);
      expect(doorLock().lockState).not.toBeUndefined();
      await server.close();
    }
  });
});
