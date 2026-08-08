import type { Connection } from "home-assistant-js-websocket";
import { afterEach, describe, expect, it } from "vitest";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "werift";
import {
  DEFAULT_HA_WEBRTC_TIMEOUT_MS,
  setHaWebRtcTimeoutMsForTests,
  WebRtcBridge,
} from "./webrtc-bridge.js";

// Exercises the real WebRtcBridge with the HA websocket faked. A local werift
// peer stands in for HA: it answers the bridge's offer and pumps RTP, so we can
// prove the relay forwards media end to end, and that a HA error/timeout makes
// provideOffer reject instead of hanging (the old behavior).

type FakeMode = "answer" | "error" | "silent";

interface FakeHa {
  connect: () => Promise<Connection>;
  unsubscribeCalls: number[];
  unsubscribedIds: number[];
  cleanup: () => Promise<void>;
}

// A fake HA connection. In "answer" mode a werift peer plays HA: it answers the
// bridge offer with its own local description (host candidates embedded) and
// pumps a video RTP stream. "error" replies like a camera with no WebRTC
// provider; "silent" never replies so the bridge must time out.
function makeFakeHa(mode: FakeMode): FakeHa {
  const peers: RTCPeerConnection[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const unsubscribeCalls: number[] = [];
  const unsubscribedIds: number[] = [];
  let subscriptionSeq = 0;

  const connect = async (): Promise<Connection> => {
    const conn = {
      async subscribeMessage(
        callback: (msg: unknown) => void,
        message: { offer?: string },
      ): Promise<() => Promise<void>> {
        if (mode === "silent") {
          return async () => {};
        }
        if (mode === "error") {
          queueMicrotask(() =>
            callback({
              type: "error",
              code: "webrtc_offer_failed",
              message: "Camera does not support WebRTC",
            }),
          );
          return async () => {};
        }

        const haPeer = new RTCPeerConnection();
        peers.push(haPeer);
        const track = new MediaStreamTrack({ kind: "video" });
        haPeer.addTransceiver(track, { direction: "sendonly" });
        await haPeer.setRemoteDescription({
          type: "offer",
          sdp: message.offer ?? "",
        });
        const answer = await haPeer.createAnswer();
        await haPeer.setLocalDescription(answer);
        // Resolve the subscription before streaming events, like the real
        // websocket does; the bridge captures the unsubscribe from that ack.
        queueMicrotask(() => {
          callback({ type: "session", session_id: "sess-1" });
          callback({
            type: "answer",
            answer: haPeer.localDescription?.sdp ?? "",
          });
        });

        let seq = 1;
        const iv = setInterval(() => {
          const header = new RtpHeader({
            payloadType: 96,
            sequenceNumber: seq++ & 0xffff,
            timestamp: seq * 3000,
            ssrc: 4242,
          });
          track.writeRtp(new RtpPacket(header, Buffer.alloc(200, 3)));
        }, 20);
        timers.push(iv);
        const id = ++subscriptionSeq;
        unsubscribeCalls.push(id);
        return async () => {
          unsubscribedIds.push(id);
          clearInterval(iv);
        };
      },
      async sendMessagePromise() {
        return undefined;
      },
      close() {},
    };
    return conn as unknown as Connection;
  };

  const cleanup = async (): Promise<void> => {
    for (const t of timers) clearInterval(t);
    for (const p of peers) await p.close().catch(() => {});
  };

  return { connect, unsubscribeCalls, unsubscribedIds, cleanup };
}

function sdpOf(peer: RTCPeerConnection): string {
  const local = peer.localDescription;
  if (!local) throw new Error("no local description");
  return local.sdp;
}

async function makeControllerOffer(peer: RTCPeerConnection): Promise<string> {
  peer.addTransceiver("video", { direction: "recvonly" });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  return sdpOf(peer);
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const c of cleanups) {
    try {
      await c();
    } catch {
      // best effort teardown
    }
  }
  cleanups = [];
  setHaWebRtcTimeoutMsForTests(DEFAULT_HA_WEBRTC_TIMEOUT_MS);
});

describe("WebRtcBridge media relay", () => {
  it("returns an answer SDP and forwards RTP end to end", async () => {
    const fake = makeFakeHa("answer");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = new RTCPeerConnection();
    cleanups.push(() => controller.close());
    let received = 0;
    controller.onTrack.subscribe((t) =>
      t.onReceiveRtp.subscribe(() => {
        received++;
      }),
    );
    const offerSdp = await makeControllerOffer(controller);

    const answerSdp = await bridge.acceptControllerOffer(
      1,
      "camera.front",
      offerSdp,
    );
    expect(answerSdp).toMatch(/m=video/);
    await controller.setRemoteDescription({ type: "answer", sdp: answerSdp });

    await waitFor(() => received > 0, 6000);
    expect(received).toBeGreaterThan(0);

    // Ending the session must drop the HA subscription, not just the peers.
    await bridge.endSession(1);
    expect(fake.unsubscribedIds).toEqual(fake.unsubscribeCalls);
  }, 12_000);

  it("rejects when HA replies with an error instead of hanging", async () => {
    // Keep the HA timeout long so only the error path can reject quickly; the
    // 6s test timeout would fire first if the error were ignored (old bug).
    setHaWebRtcTimeoutMsForTests(10_000);
    const fake = makeFakeHa("error");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = new RTCPeerConnection();
    cleanups.push(() => controller.close());
    const offerSdp = await makeControllerOffer(controller);

    await expect(
      bridge.acceptControllerOffer(2, "camera.bad", offerSdp),
    ).rejects.toThrow(/HA WebRTC error/);
  }, 6_000);

  it("rejects after the HA answer timeout when HA never replies", async () => {
    setHaWebRtcTimeoutMsForTests(400);
    const fake = makeFakeHa("silent");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = new RTCPeerConnection();
    cleanups.push(() => controller.close());
    const offerSdp = await makeControllerOffer(controller);

    const start = Date.now();
    await expect(
      bridge.acceptControllerOffer(3, "camera.slow", offerSdp),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  }, 5_000);
});
