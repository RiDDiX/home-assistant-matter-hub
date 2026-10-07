import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, EndpointNumber, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import type { SecureSession } from "@matter/protocol";
import { StreamUsage } from "@matter/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AggregatorEndpoint } from "../../../matter/endpoints/aggregator-endpoint.js";
import { createCameraEndpointType } from "./camera-endpoint.js";
import {
  type RequestorInvocation,
  registerRequestor,
  setRequestorInvokeForTests,
  unregisterRequestor,
} from "./requestor-client.js";
import type { WebRtcBridge } from "./webrtc-bridge.js";

// Proves the ProvideOffer handler routes the computed answer back through the
// requestor client after the response went out, and tears the session down when
// delivery keeps failing. Offline act carries no Matter session, so we
// pre-register a fake session on the module registry to exercise the seam.

const ANSWER = "v=0 the-answer";

interface FakeBridge {
  bridge: WebRtcBridge;
  endedSessions: number[];
}

function fakeBridge(): FakeBridge {
  const endedSessions: number[] = [];
  const bridge = {
    acceptControllerOffer: async () => ANSWER,
    endSession: async (id: number) => {
      endedSessions.push(id);
    },
    snapshot: async () => new Uint8Array(0),
  } as unknown as WebRtcBridge;
  return { bridge, endedSessions };
}

const fakeEnv = {} as unknown as Environment;
function openSession(): SecureSession {
  return { isClosed: false } as unknown as SecureSession;
}

let dir: string;
let env: Environment;
const servers: ServerNode[] = [];
let counter = 0;
const touched = new Set<number>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-webrtc-provider-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});

afterEach(async () => {
  // one test mounts two cameras, close every node before the dir goes
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => {})));
  for (const id of touched) unregisterRequestor(id);
  touched.clear();
  setRequestorInvokeForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function mountCamera(
  bridge: WebRtcBridge,
  endpointId = "camera",
): Promise<Endpoint> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `webrtc-provider-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    createCameraEndpointType(bridge, `camera.${endpointId}`) as never,
    { id: endpointId },
  );
  await aggregator.add(endpoint);
  return endpoint;
}

function provideOffer(
  endpoint: Endpoint,
  sessionId: number | null,
  streams: { videoStreamId?: number | null; videoStreams?: number[] } = {
    videoStreamId: null,
  },
): Promise<{ webRtcSessionId: number; videoStreamId?: number }> {
  return endpoint.act((agent) =>
    // biome-ignore lint/suspicious/noExplicitAny: invoke provideOffer directly
    (agent as any).webRtcTransportProvider.provideOffer({
      webRtcSessionId: sessionId,
      sdp: "v=0 controller-offer",
      streamUsage: StreamUsage.LiveView,
      originatingEndpointId: EndpointNumber(1),
      audioStreamId: null,
      ...streams,
    }),
  ) as Promise<{ webRtcSessionId: number; videoStreamId?: number }>;
}

function allocatedVideoStreams(
  endpoint: Endpoint,
): { videoStreamId: number }[] {
  // biome-ignore lint/suspicious/noExplicitAny: read behavior state
  return (endpoint.state as any).cameraAvStreamManagement.allocatedVideoStreams;
}

describe("provideOffer answer delivery", () => {
  it("delivers the bridge answer through the requestor seam", async () => {
    const invocations: RequestorInvocation[] = [];
    setRequestorInvokeForTests(async (i) => {
      invocations.push(i);
      return true;
    });
    const { bridge } = fakeBridge();
    const endpoint = await mountCamera(bridge);
    // Offline act has no session, so stand in a registration for id 42.
    touched.add(42);
    registerRequestor(42, {
      session: openSession(),
      requestorEndpoint: EndpointNumber(1),
      env: fakeEnv,
    });

    const res = await provideOffer(endpoint, 42);

    expect(res.webRtcSessionId).toBe(42);
    // Delivery is deferred past the response, so wait for the seam.
    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    expect(invocations[0].request.command).toBe("answer");
    expect(invocations[0].request.fields).toEqual({
      webRtcSessionId: 42,
      sdp: ANSWER,
    });
  });

  it("delivers the answer only after the response has been returned", async () => {
    // Spec flow: the controller learns the minted webRtcSessionId from the
    // ProvideOfferResponse, so the Answer invoke must not race ahead of it.
    const order: string[] = [];
    setRequestorInvokeForTests(async () => {
      order.push("answer");
      return true;
    });
    const { bridge } = fakeBridge();
    const endpoint = await mountCamera(bridge);
    touched.add(44);
    registerRequestor(44, {
      session: openSession(),
      requestorEndpoint: EndpointNumber(1),
      env: fakeEnv,
    });

    await provideOffer(endpoint, 44);
    order.push("response");

    await vi.waitFor(() => expect(order).toContain("answer"));
    expect(order.indexOf("response")).toBeLessThan(order.indexOf("answer"));
  });

  it("mints distinct session ids across camera endpoints", async () => {
    // The requestor registry and bridge session map are process wide, so two
    // cameras minting from per-endpoint counters would cross-talk.
    setRequestorInvokeForTests(async () => true);
    const { bridge } = fakeBridge();
    const a = await mountCamera(bridge, "cam-a");
    const b = await mountCamera(bridge, "cam-b");

    const ra = await provideOffer(a, null);
    const rb = await provideOffer(b, null);
    touched.add(ra.webRtcSessionId);
    touched.add(rb.webRtcSessionId);

    expect(ra.webRtcSessionId).not.toBe(rb.webRtcSessionId);
  });

  it("ends the bridge session when deferred delivery fails, response already out", async () => {
    setRequestorInvokeForTests(async () => false);
    const { bridge, endedSessions } = fakeBridge();
    const endpoint = await mountCamera(bridge);
    touched.add(43);
    registerRequestor(43, {
      session: openSession(),
      requestorEndpoint: EndpointNumber(1),
      env: fakeEnv,
    });

    // The response went out before delivery, so the handler cannot throw.
    const res = await provideOffer(endpoint, 43);
    expect(res.webRtcSessionId).toBe(43);
    // All retries fail, then the session is torn down.
    await vi.waitFor(() => expect(endedSessions).toContain(43), {
      timeout: 3000,
    });
  });
});

// Matter 1.5 sessions must name a stream; a controller may send the list, the
// older single id, or nothing (#373).
describe("provideOffer video stream", () => {
  it("echoes the older VideoStreamID the controller sent", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null, { videoStreamId: 7 });
    touched.add(res.webRtcSessionId);

    expect(res.videoStreamId).toBe(7);
  });

  it("allocates a stream when the offer names none", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null);
    touched.add(res.webRtcSessionId);

    const streams = allocatedVideoStreams(endpoint);
    expect(streams).toHaveLength(1);
    expect(res.videoStreamId).toBe(streams[0].videoStreamId);
  });

  it("reuses a stream the controller allocated", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const allocated = (await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke the command directly
      (agent as any).cameraAvStreamManagement.videoStreamAllocate({
        streamUsage: StreamUsage.LiveView,
        videoCodec: 0,
        minFrameRate: 15,
        maxFrameRate: 30,
        minResolution: { width: 640, height: 360 },
        maxResolution: { width: 1920, height: 1080 },
        minBitRate: 10_000,
        maxBitRate: 4_000_000,
        keyFrameInterval: 4000,
      }),
    )) as { videoStreamId: number };

    const res = await provideOffer(endpoint, null);
    touched.add(res.webRtcSessionId);

    expect(allocatedVideoStreams(endpoint)).toHaveLength(1);
    expect(res.videoStreamId).toBe(allocated.videoStreamId);
  });

  it("leaves the response without VideoStreamID when the offer had none", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null, { videoStreams: [3] });
    touched.add(res.webRtcSessionId);

    expect(res.videoStreamId).toBeUndefined();
  });
});

// CHIP based controllers wait about 2 s for an invoke response, pulling HA's
// stream takes longer, so the response must not wait for it (#373).
describe("provideOffer negotiates after responding", () => {
  it("responds while HA has not answered yet", async () => {
    setRequestorInvokeForTests(async () => true);
    const bridge = {
      acceptControllerOffer: () => new Promise<string>(() => {}),
      endSession: async () => {},
      snapshot: async () => new Uint8Array(0),
    } as unknown as WebRtcBridge;
    const endpoint = await mountCamera(bridge);

    const res = await provideOffer(endpoint, null);
    touched.add(res.webRtcSessionId);

    expect(res.webRtcSessionId).toBeTypeOf("number");
  });

  it("ends the session on the controller when HA can't deliver", async () => {
    const invocations: RequestorInvocation[] = [];
    setRequestorInvokeForTests(async (i) => {
      invocations.push(i);
      return true;
    });
    const endedSessions: number[] = [];
    const bridge = {
      acceptControllerOffer: async () => {
        throw new Error("HA WebRTC error: Camera does not support WebRTC");
      },
      endSession: async (id: number) => {
        endedSessions.push(id);
      },
      snapshot: async () => new Uint8Array(0),
    } as unknown as WebRtcBridge;
    const endpoint = await mountCamera(bridge);
    touched.add(45);
    registerRequestor(45, {
      session: openSession(),
      requestorEndpoint: EndpointNumber(1),
      env: fakeEnv,
    });

    const res = await provideOffer(endpoint, 45);
    expect(res.webRtcSessionId).toBe(45);

    await vi.waitFor(() => expect(endedSessions).toContain(45));
    expect(invocations.map((i) => i.request.command)).toEqual(["end"]);
    expect(invocations[0].request.fields).toEqual({
      webRtcSessionId: 45,
      reason: 5, // NoUserMedia
    });
  });
});

describe("videoStreamAllocate", () => {
  it("takes SmartThings' watermark and OSD flags without storing them", async () => {
    // SmartThings always sends both; with no WMARK/OSD feature, storing even
    // false failed conformance and the allocation with it
    const endpoint = await mountCamera(fakeBridge().bridge);
    const res = (await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke the command directly
      (agent as any).cameraAvStreamManagement.videoStreamAllocate({
        streamUsage: StreamUsage.LiveView,
        videoCodec: 0,
        minFrameRate: 15,
        maxFrameRate: 30,
        minResolution: { width: 640, height: 360 },
        maxResolution: { width: 1920, height: 1080 },
        minBitRate: 10_000,
        maxBitRate: 4_000_000,
        keyFrameInterval: 4000,
        watermarkEnabled: false,
        osdEnabled: false,
      }),
    )) as { videoStreamId: number };

    expect(allocatedVideoStreams(endpoint)).toEqual([
      expect.objectContaining({ videoStreamId: res.videoStreamId }),
    ]);
  });
});
