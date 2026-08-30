// requirePinForRemoteOperation was written only by update(), which runs on a
// Home Assistant state change. A PIN added through a controller or the web API
// therefore was not enforced, and unlockDoor kept letting a PIN-less command
// through until the entity happened to change.
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
import type { AppStorage } from "../../../../services/storage/app-storage.js";
import { LockCredentialStorage } from "../../../../services/storage/lock-credential-storage.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LockDevice } from "./index.js";

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let storage: LockCredentialStorage;
let server: ServerNode | undefined;

const memoryAppStorage = () =>
  ({
    createContext: () => ({
      get: async () => ({ version: 2, credentials: [] }),
      set: async () => {},
    }),
  }) as unknown as AppStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-pin-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    async callAction() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  storage = new LockCredentialStorage(memoryAppStorage());
  await storage.construction;
  env.set(LockCredentialStorage, storage);
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

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function lockEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: "lock.front_door",
    state: "locked",
    attributes: { friendly_name: "Front Door", supported_features: 0 },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door", state: state as any };
}

async function mount() {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "lock-pin-node",
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
  return endpoint;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unlock(endpoint: Endpoint, pinCode?: Uint8Array) {
  return endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke the door lock command
    await (agent as any).doorLock.unlockDoor({ pinCode: pinCode ?? null });
  });
}

describe("PIN enforcement follows the credential store (#464 follow-up)", () => {
  it("enforces a PIN added without any Home Assistant state change", async () => {
    const endpoint = await mount();
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).doorLock.requirePinForRemoteOperation).toBe(
      false,
    );
    await unlock(endpoint);
    expect(calls.length).toBe(1);

    await storage.setCredential({
      entityId: "lock.front_door",
      pinCode: "4321",
    });
    await delay(30);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).doorLock.requirePinForRemoteOperation).toBe(
      true,
    );
    calls.length = 0;
    await expect(unlock(endpoint)).rejects.toThrow();
    expect(calls.length).toBe(0);

    await unlock(endpoint, new TextEncoder().encode("4321"));
    expect(calls.length).toBe(1);
  });

  it("stops requiring a PIN once the credential is gone", async () => {
    const endpoint = await mount();
    await storage.setCredential({
      entityId: "lock.front_door",
      pinCode: "4321",
    });
    await delay(30);
    await storage.deleteCredential("lock.front_door");
    await delay(30);

    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).doorLock.requirePinForRemoteOperation).toBe(
      false,
    );
    calls.length = 0;
    await unlock(endpoint);
    expect(calls.length).toBe(1);
  });
});
