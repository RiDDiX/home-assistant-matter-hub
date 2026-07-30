import type { Environment } from "@matter/general";
import { EndpointNumber } from "@matter/main";
import { WebRtcTransportRequestor } from "@matter/main/clusters";
import type { SecureSession } from "@matter/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  deliverAnswerDeferred,
  type RequestorInvocation,
  registerRequestor,
  sendAnswer,
  sendEnd,
  sendIceCandidates,
  setRequestorInvokeForTests,
  unregisterAllRequestors,
  unregisterRequestor,
} from "./requestor-client.js";

// Unit tests for the WebRtcTransportRequestor client. The matter.js exchange
// stack is replaced with an injected invoke seam so we assert the built command
// request without standing up real sessions.

const env = {} as unknown as Environment;

function session(isClosed: boolean): SecureSession {
  return { isClosed } as unknown as SecureSession;
}

// Capturing seam: records every invocation and returns a preset result.
function capturing(result = true): {
  invocations: RequestorInvocation[];
  fn: (i: RequestorInvocation) => Promise<boolean>;
} {
  const invocations: RequestorInvocation[] = [];
  return {
    invocations,
    fn: async (i) => {
      invocations.push(i);
      return result;
    },
  };
}

// Ids touched by a test, unregistered in afterEach so the module registry does
// not leak between tests.
const touched = new Set<number>();
function track(id: number): number {
  touched.add(id);
  return id;
}

afterEach(() => {
  for (const id of touched) unregisterRequestor(id);
  touched.clear();
  setRequestorInvokeForTests(undefined);
});

describe("requestor registry", () => {
  it("routes a send to the registered session and endpoint", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    const s = session(false);
    registerRequestor(track(10), {
      session: s,
      requestorEndpoint: EndpointNumber(4),
      env,
    });

    const ok = await sendAnswer(10, "v=0 answer");

    expect(ok).toBe(true);
    expect(cap.invocations).toHaveLength(1);
    expect(cap.invocations[0].registration.session).toBe(s);
    expect(cap.invocations[0].request.endpoint).toBe(EndpointNumber(4));
  });

  it("returns false and skips the seam when nothing is registered", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);

    const ok = await sendAnswer(track(11), "v=0 answer");

    expect(ok).toBe(false);
    expect(cap.invocations).toHaveLength(0);
  });

  it("stops routing after unregister", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(track(12), {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    unregisterRequestor(12);

    const ok = await sendAnswer(12, "v=0 answer");

    expect(ok).toBe(false);
    expect(cap.invocations).toHaveLength(0);
  });

  it("double-register replaces the prior entry", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    const first = session(false);
    const second = session(false);
    registerRequestor(track(13), {
      session: first,
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    registerRequestor(13, {
      session: second,
      requestorEndpoint: EndpointNumber(9),
      env,
    });

    await sendAnswer(13, "v=0 answer");

    expect(cap.invocations[0].registration.session).toBe(second);
    expect(cap.invocations[0].request.endpoint).toBe(EndpointNumber(9));
  });
});

describe("deferred answer delivery", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("unregister cancels a pending delivery before it fires", async () => {
    const cap = capturing(true);
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(70, {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    let gaveUp = false;
    deliverAnswerDeferred(70, "sdp", async () => {
      gaveUp = true;
    });
    unregisterRequestor(70);

    await delay(60);
    expect(cap.invocations).toHaveLength(0);
    expect(gaveUp).toBe(false);
  });

  it("a superseding delivery for the same id silences the prior one", async () => {
    const cap = capturing(true);
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(73, {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    deliverAnswerDeferred(73, "stale-sdp", async () => {});
    // Re-offer under the same id: fresh registration, fresh delivery.
    registerRequestor(73, {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    deliverAnswerDeferred(73, "fresh-sdp", async () => {});

    await delay(60);
    expect(cap.invocations).toHaveLength(1);
    expect(cap.invocations[0].request.fields.sdp).toBe("fresh-sdp");
    unregisterRequestor(73);
  });

  it("unregisterAllRequestors clears registrations and pending deliveries", async () => {
    const cap = capturing(true);
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(71, {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    registerRequestor(72, {
      session: session(false),
      requestorEndpoint: EndpointNumber(1),
      env,
    });
    deliverAnswerDeferred(71, "sdp", async () => {});
    unregisterAllRequestors();

    await delay(60);
    expect(cap.invocations).toHaveLength(0);
    expect(await sendAnswer(72, "sdp")).toBe(false);
  });
});

describe("requestor send helpers", () => {
  it("sendAnswer builds the answer command with cluster, endpoint and fields", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(track(20), {
      session: session(false),
      requestorEndpoint: EndpointNumber(2),
      env,
    });

    await sendAnswer(20, "v=0 the-answer");

    const req = cap.invocations[0].request;
    expect(req.cluster).toBe(WebRtcTransportRequestor.Cluster);
    expect(req.command).toBe("answer");
    expect(req.endpoint).toBe(EndpointNumber(2));
    expect(req.fields).toEqual({ webRtcSessionId: 20, sdp: "v=0 the-answer" });
  });

  it("sendIceCandidates builds the iceCandidates command", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(track(21), {
      session: session(false),
      requestorEndpoint: EndpointNumber(2),
      env,
    });
    const candidates = [
      { candidate: "candidate:1 1 udp", sdpMid: "0", sdpmLineIndex: 0 },
    ];

    await sendIceCandidates(21, candidates);

    const req = cap.invocations[0].request;
    expect(req.command).toBe("iceCandidates");
    expect(req.fields).toEqual({
      webRtcSessionId: 21,
      iceCandidates: candidates,
    });
  });

  it("sendEnd builds the end command with the reason", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(track(22), {
      session: session(false),
      requestorEndpoint: EndpointNumber(2),
      env,
    });

    await sendEnd(22, 2);

    const req = cap.invocations[0].request;
    expect(req.command).toBe("end");
    expect(req.fields).toEqual({ webRtcSessionId: 22, reason: 2 });
  });

  it("returns false without invoking the seam when the session is closed", async () => {
    const cap = capturing();
    setRequestorInvokeForTests(cap.fn);
    registerRequestor(track(23), {
      session: session(true),
      requestorEndpoint: EndpointNumber(2),
      env,
    });

    const ok = await sendAnswer(23, "v=0 answer");

    expect(ok).toBe(false);
    expect(cap.invocations).toHaveLength(0);
  });

  it("returns false when the transport throws, without propagating", async () => {
    setRequestorInvokeForTests(async () => {
      throw new Error("exchange blew up");
    });
    registerRequestor(track(24), {
      session: session(false),
      requestorEndpoint: EndpointNumber(2),
      env,
    });

    await expect(sendAnswer(24, "v=0 answer")).resolves.toBe(false);
  });
});
