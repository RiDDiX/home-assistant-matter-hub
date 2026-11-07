import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityInformation,
  MediaPlayerDeviceClass,
  MediaPlayerDeviceFeature,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { KeypadInput, MediaPlayback } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { MediaPlayerDevice } from "./index.js";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-tv-"));
  calls = [];
  env = new Environment("test", Environment.default);
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
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function tvEntity(
  supported_features: number,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityInformation {
  const state = {
    entity_id: "media_player.tv",
    state: "on",
    attributes: {
      friendly_name: "TV",
      device_class: MediaPlayerDeviceClass.Tv,
      supported_features,
      source_list: ["HDMI 1", "HDMI 2"],
      source: "HDMI 1",
      ...attributes,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "media_player.tv", state: state as any };
}

async function bringUp(entity: HomeAssistantEntityInformation) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "tv-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(MediaPlayerDevice({ entity } as never), {
    id: "tv",
  });
  await aggregator.add(endpoint);
  return endpoint;
}

// biome-ignore lint/suspicious/noExplicitAny: drive cluster commands
async function act(endpoint: Endpoint, fn: (agent: any) => unknown) {
  let result: unknown;
  await endpoint.act(async (agent) => {
    result = await fn(agent);
  });
  return result;
}

describe("tv media_player bring-up", () => {
  it("mounts a TV that only supports source selection", async () => {
    const endpoint = await bringUp(
      tvEntity(MediaPlayerDeviceFeature.SELECT_SOURCE),
    );
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    expect((endpoint.state as any).mediaPlayback.currentState).toBe(
      MediaPlayback.PlaybackState.NotPlaying,
    );
  });

  it("binds OnOff to HA when only TURN_OFF is supported", async () => {
    const endpoint = await bringUp(tvEntity(MediaPlayerDeviceFeature.TURN_OFF));
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    expect((endpoint.state as any).onOff.onOff).toBe(true);

    await act(endpoint, (agent) => agent.onOff.on());
    expect(calls).toEqual([]);
    await act(endpoint, (agent) => agent.onOff.off());
    expect(calls).toEqual([{ action: "media_player.turn_off" }]);
  });

  it("sends is_volume_muted with the keypad mute keys", async () => {
    const endpoint = await bringUp(
      tvEntity(MediaPlayerDeviceFeature.VOLUME_MUTE, {
        is_volume_muted: false,
      }),
    );
    for (const keyCode of [
      KeypadInput.CecKeyCode.Mute,
      KeypadInput.CecKeyCode.MuteFunction,
      KeypadInput.CecKeyCode.RestoreVolumeFunction,
    ]) {
      await act(endpoint, (agent) => agent.keypadInput.sendKey({ keyCode }));
    }
    expect(calls.map((c) => c.data)).toEqual([
      { is_volume_muted: true },
      { is_volume_muted: true },
      { is_volume_muted: false },
    ]);
  });

  it("rejects an unknown input index", async () => {
    const endpoint = await bringUp(
      tvEntity(MediaPlayerDeviceFeature.SELECT_SOURCE),
    );
    await expect(
      act(endpoint, (agent) => agent.mediaInput.selectInput({ index: 5 })),
    ).rejects.toThrow("Unknown input index 5");
    expect(calls).toEqual([]);
  });
});

describe("speaker media_player bring-up", () => {
  it("keeps the volume read-only without VOLUME_SET", async () => {
    const entity = tvEntity(0, { device_class: "speaker", volume_level: 0.5 });
    const endpoint = await bringUp(entity);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    expect((endpoint.state as any).levelControl.currentLevel).toBe(127);

    await act(endpoint, (agent) =>
      agent.levelControl.moveToLevel({
        level: 200,
        transitionTime: 0,
        optionsMask: {},
        optionsOverride: {},
      }),
    );
    expect(calls).toEqual([]);
    // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
    expect((endpoint.state as any).levelControl.currentLevel).toBe(127);
  });
});
