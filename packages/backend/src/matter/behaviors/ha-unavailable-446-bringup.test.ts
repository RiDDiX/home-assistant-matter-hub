import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityInformation,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { StatusResponseError } from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// endpoint.act() runs with a local actor, and the guard deliberately only
// fires for a remote controller, so the offline check is forced false here to
// drive the path a real Matter command takes.
vi.mock("../../utils/transaction-is-offline.js", () => ({
  transactionIsOffline: () => false,
}));

import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

// #446: a command used to return SUCCESS and keep its optimistic attribute
// even when the HA call could never be made, so controllers showed a state
// the device never reached. Commands now fail while HA is unreachable.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

function setActions(actions: object) {
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, actions as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-446-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
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

function entity(
  entityId: string,
  state: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state,
    attributes: { friendly_name: "Thing", ...attributes },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(
  info: HomeAssistantEntityInformation,
  matterDeviceType: MatterDeviceType,
) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `ha446-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const type = createLegacyEndpointType(info, {
    entityId: info.entity_id,
    matterDeviceType,
  });
  if (!type) throw new Error("no endpoint type");
  const endpoint = new Endpoint(type, { id: "dev" });
  await aggregator.add(endpoint);
  return endpoint;
}

describe("commands fail while Home Assistant is unreachable (#446)", () => {
  it("rejects on/off and sends nothing", async () => {
    setActions({
      available: false,
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const endpoint = await mount(entity("light.a", "off"), "on_off_light");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (async () => endpoint.act((agent) => (agent as any).onOff.on()))(),
    ).rejects.toThrow(StatusResponseError);
    expect(calls).toEqual([]);
  });

  it("leaves the optimistic attribute untouched after the rejection", async () => {
    setActions({
      available: false,
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const endpoint = await mount(entity("light.b", "off"), "on_off_light");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (async () => endpoint.act((agent) => (agent as any).onOff.on()))(),
    ).rejects.toThrow();

    // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
    const on = await endpoint.act((agent) => (agent as any).onOff.state.onOff);
    expect(on).toBe(false);
  });

  it("rejects a cover move before the target position is written", async () => {
    setActions({
      available: false,
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const endpoint = await mount(
      entity("cover.a", "open", {
        current_position: 100,
        // lift with position: open + close + set_position + stop
        supported_features: 1 + 2 + 4 + 8,
      }),
      "window_covering",
    );

    await expect(
      endpoint.act(async (agent) => {
        // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
        await (agent as any).windowCovering.goToLiftPercentage({
          liftPercent100thsValue: 5000,
        });
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);

    const target = await endpoint.act(
      (agent) =>
        // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
        (agent as any).windowCovering.state.targetPositionLiftPercent100ths,
    );
    expect(target).toBe(0);
  });

  it("fails only the entity whose calls keep failing", async () => {
    const blocked = new Set(["light.broken"]);
    setActions({
      available: true,
      isTargetBlocked: (id: string) => blocked.has(id),
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const broken = await mount(entity("light.broken", "off"), "on_off_light");

    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (async () => broken.act((agent) => (agent as any).onOff.on()))(),
    ).rejects.toThrow(StatusResponseError);
    expect(calls).toEqual([]);

    // A healthy entity on the same bridge is untouched.
    await server?.close();
    const fine = await mount(entity("light.fine", "off"), "on_off_light");
    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await fine.act((agent) => (agent as any).onOff.on());
    expect(calls.map((c) => c.action)).toContain("light.turn_on");
  });

  it("dispatches normally while HA is up", async () => {
    setActions({
      available: true,
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const endpoint = await mount(entity("light.c", "off"), "on_off_light");

    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).onOff.on());
    expect(calls.map((c) => c.action)).toContain("light.turn_on");
  });

  it("dispatches for a stub that has no availability at all", async () => {
    // The shape 40 existing tests use: no `available` member. Undefined must
    // read as "no opinion", never as unavailable.
    setActions({
      call(a: HomeAssistantAction) {
        calls.push(a);
      },
    });
    const endpoint = await mount(entity("light.d", "off"), "on_off_light");

    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).onOff.on());
    expect(calls.map((c) => c.action)).toContain("light.turn_on");
  });
});
