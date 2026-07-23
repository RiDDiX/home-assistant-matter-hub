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

// #418 follow-up: per-entity PIN length override so controllers advertise the
// exact length a physical lock accepts (Apple Home enforces the bounds in its
// PIN UI).

let dir: string;
let env: Environment;

class FakeStorage {
  credentials = new Map<string, LockCredential>();

  hasCredential(entityId: string): boolean {
    const c = this.credentials.get(entityId);
    return !!c?.enabled && !!c.pinCodeHash;
  }

  getCredential(entityId: string): LockCredential | undefined {
    return this.credentials.get(entityId);
  }

  async deleteCredential(entityId: string): Promise<void> {
    this.credentials.delete(entityId);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-lock-pinlen-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(_action: HomeAssistantAction) {},
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

// Mounts the lock and reads back the advertised PIN length bounds.
async function mountPinLengths(
  mapping: EntityMappingConfig | undefined,
): Promise<{ min: number; max: number }> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "lock-pinlen-node",
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
  let result = { min: -1, max: -1 };
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read the door lock state
    const doorLock = (agent as any).doorLock;
    result = {
      min: doorLock.state.minPinCodeLength,
      max: doorLock.state.maxPinCodeLength,
    };
  });
  await server.close().catch(() => {});
  return result;
}

describe("door lock PIN length override (#418)", () => {
  it("advertises the exact length when min == max", async () => {
    const { min, max } = await mountPinLengths({
      entityId: "lock.front_door",
      lockPinMinLength: 6,
      lockPinMaxLength: 6,
    });
    expect(min).toBe(6);
    expect(max).toBe(6);
  });

  it("keeps the 4/8 defaults without an override", async () => {
    const { min, max } = await mountPinLengths(undefined);
    expect(min).toBe(4);
    expect(max).toBe(8);
  });

  it("falls back to 4/8 when min > max", async () => {
    const { min, max } = await mountPinLengths({
      entityId: "lock.front_door",
      lockPinMinLength: 8,
      lockPinMaxLength: 6,
    });
    expect(min).toBe(4);
    expect(max).toBe(8);
  });
});
