import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
  LockCredential,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { DoorLock } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { LockCredentialStorage } from "../../../../services/storage/lock-credential-storage.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LockDevice } from "./index.js";

// #418: opt-in passthrough that also programs the physical lock slot when a
// controller sets or clears the PIN credential.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

// Just enough storage for the credential flow used by the lock server.
class FakeStorage {
  credentials = new Map<string, LockCredential>();

  hasCredential(entityId: string): boolean {
    const c = this.credentials.get(entityId);
    return !!c?.enabled && !!c.pinCodeHash;
  }

  getCredential(entityId: string): LockCredential | undefined {
    return this.credentials.get(entityId);
  }

  async setCredential(request: {
    entityId: string;
    pinCode: string;
    enabled?: boolean;
  }): Promise<LockCredential> {
    const credential: LockCredential = {
      entityId: request.entityId,
      pinCodeHash: `hash:${request.pinCode}`,
      pinCodeSalt: "salt",
      enabled: request.enabled ?? true,
      createdAt: 1,
      updatedAt: 1,
    };
    this.credentials.set(request.entityId, credential);
    return credential;
  }

  async deleteCredential(entityId: string): Promise<void> {
    this.credentials.delete(entityId);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-418-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    // Credential programming waits for Home Assistant now, so it goes through
    // callAction instead of the debounced call.
    async callAction(domain: string, name: string, data: object) {
      calls.push({ action: `${domain}.${name}`, data } as HomeAssistantAction);
    },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(LockCredentialStorage, new FakeStorage() as never);
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
    attributes: { friendly_name: "Front Door", supported_features: 0 },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "lock.front_door", state: state as any };
}

const setCredentialRequest: DoorLock.SetCredentialRequest = {
  operationType: DoorLock.DataOperationType.Add,
  credential: {
    credentialType: DoorLock.CredentialType.Pin,
    credentialIndex: 0,
  },
  credentialData: new TextEncoder().encode("4321"),
  userIndex: 1,
  userStatus: null,
  userType: null,
};

const clearCredentialRequest: DoorLock.ClearCredentialRequest = {
  credential: {
    credentialType: DoorLock.CredentialType.Pin,
    credentialIndex: 1,
  },
};

type DoorLockCommands = {
  setCredential(request: DoorLock.SetCredentialRequest): Promise<unknown>;
  clearCredential(request: DoorLock.ClearCredentialRequest): Promise<unknown>;
  clearUser(request: DoorLock.ClearUserRequest): Promise<unknown>;
};

// Mounts the lock, runs a door lock command, tears the node down, and returns
// the actions the recorder captured during the command.
async function run(
  mapping: EntityMappingConfig | undefined,
  command: (doorLock: DoorLockCommands) => Promise<unknown>,
): Promise<HomeAssistantAction[]> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "lock-418-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    LockDevice({ entity: lockEntity(), mapping } as never),
    { id: "lock" },
  );
  await aggregator.add(endpoint);
  calls.length = 0;
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: invoke the door lock command
    await command((agent as any).doorLock);
  });
  await server.close().catch(() => {});
  return calls;
}

const passthroughMapping: EntityMappingConfig = {
  entityId: "lock.front_door",
  lockUsercodeService: "zwave_js.set_lock_usercode",
  lockUsercodeSlot: 3,
};

describe("door lock usercode passthrough (#418)", () => {
  it("programs the physical slot on SetCredential", async () => {
    const recorded = await run(passthroughMapping, (doorLock) =>
      doorLock.setCredential(setCredentialRequest),
    );
    const action = recorded.find((c) => c.action.startsWith("zwave_js."));
    expect(action).toEqual({
      action: "zwave_js.set_lock_usercode",
      data: { code_slot: 3, usercode: "4321" },
    });
  });

  it("clears the physical slot on ClearCredential", async () => {
    const recorded = await run(passthroughMapping, (doorLock) =>
      doorLock.clearCredential(clearCredentialRequest),
    );
    const action = recorded.find((c) => c.action.startsWith("zwave_js."));
    expect(action).toEqual({
      action: "zwave_js.clear_lock_usercode",
      data: { code_slot: 3 },
    });
  });

  it("clears the physical slot on ClearUser", async () => {
    const recorded = await run(passthroughMapping, async (doorLock) => {
      await doorLock.setCredential(setCredentialRequest);
      await doorLock.clearUser({ userIndex: 1 });
    });
    const action = recorded.find(
      (c) => c.action === "zwave_js.clear_lock_usercode",
    );
    expect(action).toEqual({
      action: "zwave_js.clear_lock_usercode",
      data: { code_slot: 3 },
    });
  });

  it("does nothing extra without a mapping (opt-in)", async () => {
    const recorded = await run(undefined, (doorLock) =>
      doorLock.setCredential(setCredentialRequest),
    );
    expect(recorded.some((c) => c.action.startsWith("zwave_js."))).toBe(false);
  });
});
