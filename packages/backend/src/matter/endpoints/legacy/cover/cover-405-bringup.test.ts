import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { CoverDevice } from "./index.js";

// #405: an HA cover that reports set_tilt_position but NOT open_tilt (e.g.
// supported_features = open+close+set_position+set_tilt_position = 135) used to
// get no Tilt feature on any controller because HAMH gated tilt on open_tilt
// alone. set_tilt_position means the cover can tilt to a value, so it must get
// Tilt + PositionAwareTilt, and its tilt open/close must route to
// set_cover_tilt_position (it has no open_cover_tilt service).

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-cover405-"));
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

async function mount(supportedFeatures: number) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `cover405-node-${counter++}`,
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
  await aggregator.add(endpoint);
  return { server, endpoint };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// open + close + set_position + set_tilt_position, NO open_tilt.
const POSITION_PLUS_SET_TILT = 1 + 2 + 4 + 128; // 135
// every cover feature bit incl. open_tilt and set_tilt_position.
const FULL_TILT = 255;

describe("cover with set_tilt_position but no open_tilt (#405)", () => {
  it("advertises Tilt + PositionAwareTilt as a TiltBlindLift", async () => {
    const { server, endpoint } = await mount(POSITION_PLUS_SET_TILT);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const wc = (endpoint.state as any).windowCovering;
    expect(wc.featureMap.tilt).toBe(true);
    expect(wc.featureMap.positionAwareTilt).toBe(true);
    expect(wc.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    await server.close().catch(() => {});
  });

  it("routes goToTiltPercentage to set_cover_tilt_position", async () => {
    const { server, endpoint } = await mount(POSITION_PLUS_SET_TILT);
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      await a.windowCovering.goToTiltPercentage({
        tiltPercent100thsValue: 2000,
      });
    });
    // goToTiltPosition debounces before dispatching to HA.
    await delay(500);
    await server.close().catch(() => {});
    const call = calls.find(
      (c) => c.action === "cover.set_cover_tilt_position",
    );
    // Matter 2000 (20%) tilt maps to HA tilt_position 80 (0=open, 100=closed).
    expect((call?.data as { tilt_position?: number }).tilt_position).toBe(80);
    expect(calls.map((c) => c.action)).not.toContain("cover.open_cover_tilt");
  });

  it("routes tilt open to set_cover_tilt_position, not open_cover_tilt", async () => {
    const { server, endpoint } = await mount(POSITION_PLUS_SET_TILT);
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      // 0 = fully open tilt -> handleTiltOpen
      await a.windowCovering.goToTiltPercentage({ tiltPercent100thsValue: 0 });
    });
    await server.close().catch(() => {});
    const tiltCalls = calls.map((c) => c.action);
    expect(tiltCalls).toContain("cover.set_cover_tilt_position");
    expect(tiltCalls).not.toContain("cover.open_cover_tilt");
  });
});

describe("full-tilt cover keeps discrete tilt services (#405 regression)", () => {
  it("advertises Tilt + PositionAwareTilt as a TiltBlindLift", async () => {
    const { server, endpoint } = await mount(FULL_TILT);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    const wc = (endpoint.state as any).windowCovering;
    expect(wc.featureMap.tilt).toBe(true);
    expect(wc.featureMap.positionAwareTilt).toBe(true);
    expect(wc.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    await server.close().catch(() => {});
  });

  it("routes tilt open to open_cover_tilt", async () => {
    const { server, endpoint } = await mount(FULL_TILT);
    calls.length = 0;
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      const a = agent as any;
      await a.windowCovering.goToTiltPercentage({ tiltPercent100thsValue: 0 });
    });
    await server.close().catch(() => {});
    const tiltCalls = calls.map((c) => c.action);
    expect(tiltCalls).toContain("cover.open_cover_tilt");
    expect(tiltCalls).not.toContain("cover.set_cover_tilt_position");
  });
});
