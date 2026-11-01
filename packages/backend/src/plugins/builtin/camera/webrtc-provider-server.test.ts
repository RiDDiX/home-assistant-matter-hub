import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import {
  Endpoint,
  EndpointNumber,
  FabricIndex,
  LocalActorContext,
  NodeId,
  VendorId,
} from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { StatusCode } from "@matter/main/types";
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
  mutes: [string, boolean][];
}

function fakeBridge(): FakeBridge {
  const endedSessions: number[] = [];
  const mutes: [string, boolean][] = [];
  const bridge = {
    acceptControllerOffer: async () => ANSWER,
    endSession: async (id: number) => {
      endedSessions.push(id);
    },
    snapshot: async () => new Uint8Array(0),
    setMicrophoneMuted: (entityId: string, muted: boolean) =>
      mutes.push([entityId, muted]),
  } as unknown as WebRtcBridge;
  return { bridge, endedSessions, mutes };
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
  streams: {
    videoStreamId?: number | null;
    videoStreams?: number[];
    audioStreamId?: number | null;
    audioStreams?: number[];
    sdp?: string;
  } = {
    videoStreamId: null,
  },
  fromPeer = false,
): Promise<{
  webRtcSessionId: number;
  videoStreamId?: number;
  audioStreamId?: number | null;
}> {
  // biome-ignore lint/suspicious/noExplicitAny: invoke provideOffer directly
  const invoke = (agent: any) =>
    agent.webRtcTransportProvider.provideOffer({
      webRtcSessionId: sessionId,
      sdp: "v=0 controller-offer",
      streamUsage: StreamUsage.LiveView,
      originatingEndpointId: EndpointNumber(1),
      audioStreamId: null,
      ...streams,
    });
  // A controller's invoke carries its session, trackSession only lists a
  // session with a fabric. Offline act has none.
  const session = {
    isClosed: false,
    peerNodeId: NodeId(1),
    associatedFabric: { fabricIndex: FabricIndex(1) },
  };
  return (
    fromPeer
      ? LocalActorContext.act(
          "provideOffer from a peer",
          (context) => invoke(endpoint.agentFor(context)),
          { session } as never,
        )
      : endpoint.act(invoke)
  ) as Promise<{
    webRtcSessionId: number;
    videoStreamId?: number;
    audioStreamId?: number | null;
  }>;
}

function currentSessions(
  endpoint: Endpoint,
): { id: number; audioStreams?: number[]; audioStreamId?: number }[] {
  // biome-ignore lint/suspicious/noExplicitAny: read behavior state
  return (endpoint.state as any).webRtcTransportProvider.currentSessions;
}

function allocatedAudioStreams(
  endpoint: Endpoint,
): { audioStreamId: number; referenceCount: number }[] {
  // biome-ignore lint/suspicious/noExplicitAny: read behavior state
  return (endpoint.state as any).cameraAvStreamManagement.allocatedAudioStreams;
}

const opusRequest = {
  streamUsage: StreamUsage.LiveView,
  audioCodec: 0, // Opus
  channelCount: 1,
  sampleRate: 48_000,
  bitRate: 32_000,
  bitDepth: 16,
};

function audioCall(endpoint: Endpoint, command: string, request: unknown) {
  return endpoint.act((agent) =>
    // biome-ignore lint/suspicious/noExplicitAny: invoke the command directly
    (agent as any).cameraAvStreamManagement[command](request),
  ) as Promise<{ audioStreamId: number } | undefined>;
}

// What a CaptureSnapshot invoke does to the AV state while it waits for HA:
// matter.js locks the cluster for the whole command.
async function holdAvState(endpoint: Endpoint): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: behavior doubles as resource
    const av = (agent as any).cameraAvStreamManagement;
    agent.context.transaction.addResourcesSync(av);
    await agent.context.transaction.begin();
    av.state.currentFrameRate = 5;
    locked();
    await gate;
  });
  await Promise.race([ready, held]);
  return async () => {
    release();
    await held;
  };
}

const smartThingsOffer = {
  videoStreamId: 1,
  audioStreamId: undefined,
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
};

// A session as trackSession writes it, carrying one audio stream
function useAudio(endpoint: Endpoint, audioStreamId: number) {
  return endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: write behavior state
    (agent as any).webRtcTransportProvider.state.currentSessions = [
      {
        id: 7,
        peerNodeId: 1,
        peerEndpointId: 1,
        streamUsage: StreamUsage.LiveView,
        videoStreams: [1],
        videoStreamId: 1,
        audioStreams: [audioStreamId],
        audioStreamId,
        metadataEnabled: false,
        fabricIndex: 1,
      },
    ];
  });
}

// the status code a command fails with (act throws synchronously)
async function statusOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return "success";
  } catch (e) {
    return (e as { code?: unknown }).code;
  }
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

  it("drops the session when HA can't deliver and frees its audio stream", async () => {
    setRequestorInvokeForTests(async () => true);
    let haFails = () => {};
    const bridge = {
      ...fakeBridge().bridge,
      acceptControllerOffer: () =>
        new Promise<string>((_, reject) => {
          haFails = () => reject(new Error("HA WebRTC error: no stream"));
        }),
    } as unknown as WebRtcBridge;
    const endpoint = await mountCamera(bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const audioStreamId = alloc?.audioStreamId ?? -1;

    const res = await provideOffer(
      endpoint,
      null,
      { videoStreamId: 1, audioStreamId },
      true,
    );
    touched.add(res.webRtcSessionId);
    await vi.waitFor(() =>
      expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(1),
    );
    expect(currentSessions(endpoint)).toHaveLength(1);
    haFails();

    await vi.waitFor(() => expect(currentSessions(endpoint)).toEqual([]));
    await vi.waitFor(() =>
      expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(0),
    );
    await audioCall(endpoint, "audioStreamDeallocate", { audioStreamId });
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
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

// Camera requires the Audio feature; the bridge relays HA's audio track.
describe("audio streams", () => {
  it("allocates an Opus stream within MicrophoneCapabilities", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await audioCall(endpoint, "audioStreamAllocate", opusRequest);

    expect(allocatedAudioStreams(endpoint)).toEqual([
      { audioStreamId: res?.audioStreamId, ...opusRequest, referenceCount: 0 },
    ]);
  });

  it("reuses the stream when the same request comes again", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    const a = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const b = await audioCall(endpoint, "audioStreamAllocate", opusRequest);

    expect(b?.audioStreamId).toBe(a?.audioStreamId);
    expect(allocatedAudioStreams(endpoint)).toHaveLength(1);
  });

  it("refuses a sample rate outside MicrophoneCapabilities", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    expect(
      await statusOf(() =>
        audioCall(endpoint, "audioStreamAllocate", {
          ...opusRequest,
          sampleRate: 32_000, // not an Opus rate
        }),
      ),
    ).toBe(StatusCode.DynamicConstraintError);
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });

  it("allocates every Opus sample rate", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    for (const sampleRate of [8_000, 12_000, 16_000, 24_000, 48_000]) {
      expect(
        await statusOf(() =>
          audioCall(endpoint, "audioStreamAllocate", {
            ...opusRequest,
            sampleRate,
          }),
        ),
      ).toBe("success");
    }
    expect(allocatedAudioStreams(endpoint)).toHaveLength(5);
  });

  // TC-AVSM-2.5 steps 8, 12 and 15
  it.each([
    ["StreamUsage Internal", { streamUsage: StreamUsage.Internal }],
    ["a StreamUsage outside the enum", { streamUsage: 9 }],
    ["BitDepth 48", { bitDepth: 48 }],
    ["AudioCodec 10", { audioCodec: 10 }],
  ])("refuses %s with CONSTRAINT_ERROR", async (_, field) => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    expect(
      await statusOf(() =>
        audioCall(endpoint, "audioStreamAllocate", {
          ...opusRequest,
          ...field,
        }),
      ),
    ).toBe(StatusCode.ConstraintError);
  });

  it("refuses a usage missing from StreamUsagePriorities", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);

    expect(
      await statusOf(() =>
        audioCall(endpoint, "audioStreamAllocate", {
          ...opusRequest,
          streamUsage: StreamUsage.Recording,
        }),
      ),
    ).toBe(StatusCode.InvalidInState);
  });

  it("deallocates a stream and answers NOT_FOUND for an unknown one", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);
    const res = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const audioStreamId = res?.audioStreamId ?? -1;

    expect(
      await statusOf(() =>
        audioCall(endpoint, "audioStreamDeallocate", {
          audioStreamId: audioStreamId + 1,
        }),
      ),
    ).toBe(StatusCode.NotFound);
    await audioCall(endpoint, "audioStreamDeallocate", { audioStreamId });
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });

  it("echoes the AudioStreamID the controller allocated", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);

    const res = await provideOffer(endpoint, null, {
      videoStreamId: null,
      audioStreamId: alloc?.audioStreamId,
    });
    touched.add(res.webRtcSessionId);

    expect(res.audioStreamId).toBe(alloc?.audioStreamId);
  });

  it("refuses an AudioStreamID that was never allocated", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    expect(
      await statusOf(() =>
        provideOffer(endpoint, null, { videoStreamId: null, audioStreamId: 9 }),
      ),
    ).toBe(StatusCode.DynamicConstraintError);
  });

  it("refuses an audio stream listed twice", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const id = alloc?.audioStreamId ?? -1;

    expect(
      await statusOf(() =>
        provideOffer(endpoint, null, {
          videoStreams: [1],
          audioStreamId: undefined,
          audioStreams: [id, id],
        }),
      ),
    ).toBe(StatusCode.AlreadyExists);
  });

  it("assigns the LiveView audio stream when the AudioStreamID is null", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);

    const res = await provideOffer(endpoint, null, {
      videoStreamId: null,
      audioStreamId: null,
    });
    touched.add(res.webRtcSessionId);

    expect(res.audioStreamId).toBe(alloc?.audioStreamId);
    expect(allocatedAudioStreams(endpoint)).toHaveLength(1);
  });

  it("allocates nothing for a null AudioStreamID", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null, {
      videoStreamId: 1,
      audioStreamId: null,
    });
    touched.add(res.webRtcSessionId);

    expect(res.audioStreamId).toBeNull();
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });

  it("answers a null AudioStreamID while a snapshot holds the AV state", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const release = await holdAvState(endpoint);

    const res = await statusOf(async () => {
      const r = await provideOffer(endpoint, null, {
        videoStreamId: 1,
        audioStreamId: null,
      });
      touched.add(r.webRtcSessionId);
    });
    await release();

    expect(res).toBe("success");
  });

  it("allocates nothing for SmartThings' offer, audio but no audio id", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null, smartThingsOffer);
    touched.add(res.webRtcSessionId);

    expect(res).not.toHaveProperty("audioStreamId");
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });

  it("answers SmartThings' offer while a snapshot holds the AV state", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const release = await holdAvState(endpoint);

    const res = await statusOf(async () => {
      const r = await provideOffer(endpoint, null, smartThingsOffer);
      touched.add(r.webRtcSessionId);
    });
    await release();

    expect(res).toBe("success");
  });

  it("counts audio use once a snapshot lets go of the AV state", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const audioStreamId = alloc?.audioStreamId ?? -1;
    const release = await holdAvState(endpoint);

    await useAudio(endpoint, audioStreamId);
    await release();

    await vi.waitFor(() =>
      expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(1),
    );
  });

  it("refuses to deallocate a stream a session uses", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const audioStreamId = alloc?.audioStreamId ?? -1;
    await useAudio(endpoint, audioStreamId);
    await vi.waitFor(() =>
      expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(1),
    );

    expect(
      await statusOf(() =>
        audioCall(endpoint, "audioStreamDeallocate", { audioStreamId }),
      ),
    ).toBe(StatusCode.InvalidInState);
    expect(allocatedAudioStreams(endpoint)).toHaveLength(1);
  });

  it("lists the audio stream in the session it counts", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);
    const audioStreamId = alloc?.audioStreamId ?? -1;

    const res = await provideOffer(
      endpoint,
      null,
      { videoStreamId: 1, audioStreamId },
      true,
    );
    touched.add(res.webRtcSessionId);

    expect(currentSessions(endpoint)).toEqual([
      expect.objectContaining({
        id: res.webRtcSessionId,
        audioStreams: [audioStreamId],
        audioStreamId,
      }),
    ]);
    await vi.waitFor(() =>
      expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(1),
    );
  });

  it("passes a MicrophoneMuted write to the bridge", async () => {
    const { bridge, mutes } = fakeBridge();
    const endpoint = await mountCamera(bridge);

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: write behavior state
      (agent as any).cameraAvStreamManagement.state.microphoneMuted = true;
    });

    await vi.waitFor(() => expect(mutes).toEqual([["camera.camera", true]]));
  });

  it("caps ReferenceCount at the uint8 maximum", async () => {
    const endpoint = await mountCamera(fakeBridge().bridge);
    const alloc = await audioCall(endpoint, "audioStreamAllocate", opusRequest);

    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: recount directly
      (agent as any).cameraAvStreamManagement.countAudioUse(
        Array(300).fill(alloc?.audioStreamId),
      ),
    );

    expect(allocatedAudioStreams(endpoint)[0].referenceCount).toBe(255);
  });

  it("names the audio stream of a re-offer", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);
    touched.add(46);
    registerRequestor(46, {
      session: openSession(),
      requestorEndpoint: EndpointNumber(1),
      env: fakeEnv,
    });

    const res = await provideOffer(endpoint, 46, {
      videoStreamId: 1,
      audioStreamId: 3,
    });

    expect(res.audioStreamId).toBe(3);
  });

  it("solicitOffer leaves audio out, its offer is video only", async () => {
    const bridge = {
      ...fakeBridge().bridge,
      startSession: async () => ({ sdp: "", iceCandidates: [] }),
    } as unknown as WebRtcBridge;
    const endpoint = await mountCamera(bridge);

    const res = (await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke solicitOffer directly
      (agent as any).webRtcTransportProvider.solicitOffer({
        streamUsage: StreamUsage.LiveView,
        originatingEndpointId: EndpointNumber(1),
        videoStreamId: null,
        audioStreamId: null,
      }),
    )) as { audioStreamId: number | null };

    expect(res.audioStreamId).toBeNull();
    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });

  it("leaves audio out of an offer without audio", async () => {
    setRequestorInvokeForTests(async () => true);
    const endpoint = await mountCamera(fakeBridge().bridge);

    const res = await provideOffer(endpoint, null, {
      videoStreamId: 1,
      audioStreamId: undefined,
      sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
    });
    touched.add(res.webRtcSessionId);

    expect(allocatedAudioStreams(endpoint)).toEqual([]);
  });
});
