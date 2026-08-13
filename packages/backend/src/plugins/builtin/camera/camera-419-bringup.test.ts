import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, Logger, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";
import { CameraAvStreamManagement } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregatorEndpoint } from "../../../matter/endpoints/aggregator-endpoint.js";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeEndpointManager } from "../../../services/bridges/bridge-endpoint-manager.js";
import { createCameraEndpointType } from "./camera-endpoint.js";
import type { WebRtcBridge } from "./webrtc-bridge.js";

// #419: the camera endpoint dropped every mandatory CameraAvStreamManagement
// attribute behind the Video feature, and enabled Audio without forwarding any,
// so init failed with an AggregateError of conformance violations. This asserts
// the endpoint mounts and carries the video/snapshot params a controller needs.

const bridge = {
  snapshot: async () => new Uint8Array(0),
} as unknown as WebRtcBridge;

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-camera419-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});

afterEach(async () => {
  // Close from afterEach so a failing assertion still tears the server down.
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(type: unknown): Promise<Endpoint> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `camera419-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type as never, { id: "camera" });
  await aggregator.add(endpoint);
  return endpoint;
}

interface CapturedState {
  sensorWidth: number;
  sensorHeight: number;
  maxFps: number;
  viewport: { x1: number; y1: number; x2: number; y2: number };
  snapCodec: number;
  snapEncoded: boolean;
  fAudio: boolean;
  fVideo: boolean;
  fSnapshot: boolean;
  bandwidth: number;
  bufferSize: number;
  rotation: number;
}

async function read(endpoint: Endpoint): Promise<CapturedState> {
  let out: CapturedState | undefined;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read behavior state
    const st = (agent as any).cameraAvStreamManagement.state;
    out = {
      sensorWidth: st.videoSensorParams.sensorWidth,
      sensorHeight: st.videoSensorParams.sensorHeight,
      maxFps: st.videoSensorParams.maxFps,
      viewport: {
        x1: st.viewport.x1,
        y1: st.viewport.y1,
        x2: st.viewport.x2,
        y2: st.viewport.y2,
      },
      snapCodec: st.snapshotCapabilities[0].imageCodec,
      snapEncoded: st.snapshotCapabilities[0].requiresEncodedPixels,
      fAudio: st.featureMap.audio,
      fVideo: st.featureMap.video,
      fSnapshot: st.featureMap.snapshot,
      bandwidth: st.maxNetworkBandwidth,
      bufferSize: st.maxContentBufferSize,
      rotation: st.imageRotation,
    };
  });
  if (!out) {
    throw new Error("no state");
  }
  return out;
}

describe("camera endpoint bring-up (#419)", () => {
  it("mounts and carries mandatory video/snapshot params", async () => {
    const endpoint = await mount(
      createCameraEndpointType(bridge, "camera.front"),
    );
    const s = await read(endpoint);

    expect(s.sensorWidth).toBe(1920);
    expect(s.sensorHeight).toBe(1080);
    expect(s.maxFps).toBe(30);
    expect(s.viewport).toEqual({ x1: 0, y1: 0, x2: 1920, y2: 1080 });
    expect(s.snapCodec).toBe(CameraAvStreamManagement.ImageCodec.Jpeg);
    expect(s.snapEncoded).toBe(false);
    expect(s.fAudio).toBe(false);
    expect(s.fVideo).toBe(true);
    expect(s.fSnapshot).toBe(true);
    expect(s.bandwidth).toBe(20_000_000);
    expect(s.bufferSize).toBe(1_048_576);
    expect(s.rotation).toBe(0);
  });

  it("threads a custom sensor into videoSensorParams and viewport", async () => {
    const endpoint = await mount(
      createCameraEndpointType(bridge, "camera.side", {
        sensorWidth: 1280,
        sensorHeight: 720,
        maxFps: 15,
      }),
    );
    const s = await read(endpoint);

    expect(s.sensorWidth).toBe(1280);
    expect(s.sensorHeight).toBe(720);
    expect(s.maxFps).toBe(15);
    expect(s.viewport).toEqual({ x1: 0, y1: 0, x2: 1280, y2: 720 });
  });
});

// #419: guards the matter.js network shape the camera-tcp path depends on.
describe("bridge server node tcp shape (#419)", () => {
  it("round-trips network.tcp through ServerNode.create", async () => {
    server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `camera419-tcp-${counter++}`,
      network: { port: 0, tcp: { incoming: true, outgoing: false } },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    // biome-ignore lint/suspicious/noExplicitAny: read network state
    expect((server.state.network as any).tcp).toEqual({
      incoming: true,
      outgoing: false,
    });
  });
});

// Every endpoint under an aggregator needs BridgedDeviceBasicInformation or
// controllers do not render it. Plugin endpoints that bring their own
// endpointType used to mount without it.
describe("plugin endpoint mounts carry bridged basic information", () => {
  it("gives a camera device its bridged basic information", async () => {
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
    server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `cam419-plugin-${counter++}`,
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });

    const pluginManager = {
      onDeviceRegistered: undefined as
        | ((name: string, device: unknown) => Promise<void>)
        | undefined,
      onDeviceUnregistered: undefined,
      getDomainMappings: () => new Map(),
    };
    const manager = new BridgeEndpointManager(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "b",
      Logger.get("Camera419"),
      pluginManager as never,
    );
    await server.add(manager.root);

    await pluginManager.onDeviceRegistered?.("camera", {
      id: "front",
      name: "Front Door",
      deviceType: "camera",
      clusters: [],
      endpointType: createCameraEndpointType(bridge, "camera.front"),
    });

    const part = [...manager.root.parts].find((p) => p.id === "plugin_front");
    if (!part) throw new Error("camera part not mounted");
    const label = await part.act(
      // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
      (agent) => (agent as any).bridgedDeviceBasicInformation.state.nodeLabel,
    );
    expect(label).toBe("Front Door");
    await manager.dispose();
  });

  it("skips an endpointType that can take neither config nor identity", async () => {
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
    server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `cam419-immutable-${counter++}`,
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });

    const pluginManager = {
      onDeviceRegistered: undefined as
        | ((name: string, device: unknown) => Promise<void>)
        | undefined,
      onDeviceUnregistered: undefined,
      getDomainMappings: () => new Map(),
    };
    const manager = new BridgeEndpointManager(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "b",
      Logger.get("Camera419immutable"),
      pluginManager as never,
    );
    await server.add(manager.root);

    // Neither with() nor set(): mounting it would drop the cluster config.
    const frozen = { deviceType: 0x0142, name: "Frozen", behaviors: {} };
    await pluginManager.onDeviceRegistered?.("camera", {
      id: "frozen",
      name: "Frozen",
      deviceType: "camera",
      clusters: [{ clusterId: "onOff", attributes: { onOff: true } }],
      endpointType: frozen,
    });

    expect([...manager.root.parts].map((p) => p.id)).not.toContain(
      "plugin_frozen",
    );
    await manager.dispose();
  });

  it("leaves a plugin that brings its own identity alone", async () => {
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
    server = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `cam419-own-${counter++}`,
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });

    const pluginManager = {
      onDeviceRegistered: undefined as
        | ((name: string, device: unknown) => Promise<void>)
        | undefined,
      onDeviceUnregistered: undefined,
      getDomainMappings: () => new Map(),
    };
    const manager = new BridgeEndpointManager(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      "b",
      Logger.get("Camera419own"),
      pluginManager as never,
    );
    await server.add(manager.root);

    // The plugin already declares the cluster, so ours must not replace it.
    const own = createCameraEndpointType(bridge, "camera.own").with(
      BridgedDeviceBasicInformationServer,
    );
    await pluginManager.onDeviceRegistered?.("camera", {
      id: "own",
      name: "Own Identity",
      deviceType: "camera",
      clusters: [
        {
          clusterId: "bridgedDeviceBasicInformation",
          attributes: { nodeLabel: "Set By Plugin", reachable: true },
        },
      ],
      endpointType: own,
    });

    const part = [...manager.root.parts].find((p) => p.id === "plugin_own");
    if (!part) throw new Error("part not mounted");
    const label = await part.act(
      // biome-ignore lint/suspicious/noExplicitAny: read the cluster state
      (agent) => (agent as any).bridgedDeviceBasicInformation.state.nodeLabel,
    );
    expect(label).toBe("Set By Plugin");
    await manager.dispose();
  });
});
