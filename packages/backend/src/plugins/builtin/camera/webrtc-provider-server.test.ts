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
let server: ServerNode | undefined;
let counter = 0;
const touched = new Set<number>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-webrtc-provider-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  for (const id of touched) unregisterRequestor(id);
  touched.clear();
  setRequestorInvokeForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function mountCamera(
  bridge: WebRtcBridge,
  endpointId = "camera",
): Promise<Endpoint> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `webrtc-provider-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
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
): Promise<{ webRtcSessionId: number }> {
  return endpoint.act((agent) =>
    // biome-ignore lint/suspicious/noExplicitAny: invoke provideOffer directly
    (agent as any).webRtcTransportProvider.provideOffer({
      webRtcSessionId: sessionId,
      sdp: "v=0 controller-offer",
      streamUsage: StreamUsage.LiveView,
      originatingEndpointId: EndpointNumber(1),
      videoStreamId: null,
      audioStreamId: null,
    }),
  ) as Promise<{ webRtcSessionId: number }>;
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
