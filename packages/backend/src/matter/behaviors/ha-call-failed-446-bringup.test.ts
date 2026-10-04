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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../../core/app/logger.js";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import type { HomeAssistantClient } from "../../services/home-assistant/home-assistant-client.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";

// #446: HA was up and the entity healthy, so the pre-check let the command
// through and it returned success. The call then failed inside HA (Z-Wave
// node offline). The optimistic attributes have to fall back to HA state.

let dir: string;
let env: Environment;
let sent: string[];
let counter = 0;
let server: ServerNode | undefined;
// answer to the nth call_service, 1-based
let reply: (n: number) => Promise<unknown>;

const nak = () =>
  Promise.reject({
    code: "home_assistant_error",
    message: "Z-Wave error 204 - The node did not acknowledge (ZW0204)",
  });

function failingActions() {
  const client = {
    haRunning: true,
    messageTimeoutMs: 1000,
    connection: {
      sendMessagePromise: async (message: {
        type: string;
        domain?: string;
        service?: string;
      }) => {
        if (message.type !== "call_service") return {};
        sent.push(`${message.domain}.${message.service}`);
        return reply(sent.length);
      },
    },
  } as unknown as HomeAssistantClient;
  const logger = {
    get: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  } as unknown as LoggerService;
  return new HomeAssistantActions(logger, client, {
    retryAttempts: 2,
    retryBaseDelayMs: 1,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-446f-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  sent = [];
  reply = nak;
  env.set(HomeAssistantActions, failingActions());
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
    id: `ha446f-node-${counter++}`,
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

// biome-ignore lint/suspicious/noExplicitAny: read the cluster state
const stateOf = (endpoint: Endpoint) => endpoint.state as any;

describe("a failed HA call rolls the command back (#446)", () => {
  it("returns a garage door cover to the HA state", async () => {
    const endpoint = await mount(
      entity("cover.garage", "closed", {
        device_class: "garage",
        current_position: 0,
        supported_features: 1 + 2 + 4 + 8,
      }),
      "window_covering",
    );
    const closed = stateOf(endpoint).windowCovering;
    expect(closed.currentPositionLiftPercent100ths).toBe(10000);
    expect(closed.targetPositionLiftPercent100ths).toBe(10000);

    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).windowCovering.upOrOpen());
    const moving = stateOf(endpoint).windowCovering;
    expect(moving.targetPositionLiftPercent100ths).toBe(0);
    expect(moving.operationalStatus.global).not.toBe(0);

    await vi.waitFor(
      () => {
        const wc = stateOf(endpoint).windowCovering;
        expect(sent).toContain("cover.open_cover");
        expect(wc.targetPositionLiftPercent100ths).toBe(10000);
        expect(wc.currentPositionLiftPercent100ths).toBe(10000);
        expect(wc.operationalStatus.global).toBe(0);
      },
      { timeout: 1000, interval: 20 },
    );
  });

  it("returns on/off to the HA state", async () => {
    const endpoint = await mount(entity("light.a", "off"), "on_off_light");

    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).onOff.on());
    expect(stateOf(endpoint).onOff.onOff).toBe(true);

    await vi.waitFor(
      () => {
        expect(sent).toContain("light.turn_on");
        expect(stateOf(endpoint).onOff.onOff).toBe(false);
      },
      { timeout: 1000, interval: 20 },
    );
  });

  it("leaves a newer call alone when an older one fails late", async () => {
    // The first call hangs into its message timeout, which is not retried;
    // the second one goes through meanwhile.
    reply = (n) =>
      n === 1
        ? new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("HA message 'x' timed out after 400ms")),
              400,
            ),
          )
        : Promise.resolve({});
    const endpoint = await mount(entity("light.b", "off"), "on_off_light");

    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).onOff.on());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
    await endpoint.act((agent) => (agent as any).onOff.on());
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    // past the first call's failure
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stateOf(endpoint).onOff.onOff).toBe(true);
  });
});
