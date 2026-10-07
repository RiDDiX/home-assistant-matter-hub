import { createSocket } from "node:dgram";
import type { Connection } from "home-assistant-js-websocket";
import { afterEach, describe, expect, it } from "vitest";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useH264,
  useOPUS,
} from "werift";
import {
  DEFAULT_HA_WEBRTC_TIMEOUT_MS,
  growRecvBuffers,
  setHaWebRtcTimeoutMsForTests,
  UDP_RECV_BUFFER,
  WebRtcBridge,
} from "./webrtc-bridge.js";

// Exercises the real WebRtcBridge with the HA websocket faked. A local werift
// peer stands in for HA: it answers the bridge's offer and pumps RTP, so we can
// prove the relay forwards media end to end, and that a HA error/timeout makes
// provideOffer reject instead of hanging (the old behavior).

type FakeMode = "answer" | "error" | "reject" | "silent";

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
        if (mode === "reject") {
          // what HA's schema check sends for a bad entity id
          throw {
            code: "invalid_format",
            message: "Message incorrectly formatted: invalid entity ID",
          };
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

        // go2rtc relays an H.264 camera as H.264
        const haPeer = new RTCPeerConnection({
          codecs: { video: [useH264()], audio: [useOPUS()] },
        });
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

// Matter controllers stream H.264
function h264Peer(): RTCPeerConnection {
  return new RTCPeerConnection({ codecs: { video: [useH264()] } });
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

    const controller = h264Peer();
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
    // An ignored error would end in the 10s timeout, whose message the regex
    // below does not match (old bug).
    setHaWebRtcTimeoutMsForTests(10_000);
    const fake = makeFakeHa("error");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = h264Peer();
    cleanups.push(() => controller.close());
    const offerSdp = await makeControllerOffer(controller);

    await expect(
      bridge.acceptControllerOffer(2, "camera.bad", offerSdp),
    ).rejects.toThrow(/HA WebRTC error/);
    // werift waits up to 5s per ICE gathering when STUN goes unanswered, and
    // two peers gather here
  }, 15_000);

  it("names HA's code and message when HA refuses the request", async () => {
    const fake = makeFakeHa("reject");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = h264Peer();
    cleanups.push(() => controller.close());
    const offerSdp = await makeControllerOffer(controller);

    await expect(
      bridge.acceptControllerOffer(4, "camera.rtsp-lq", offerSdp),
    ).rejects.toThrow(/^invalid_format: Message incorrectly formatted/);
  }, 15_000);

  it("rejects after the HA answer timeout when HA never replies", async () => {
    setHaWebRtcTimeoutMsForTests(400);
    const fake = makeFakeHa("silent");
    const bridge = new WebRtcBridge(
      { haUrl: "http://ha", haToken: "t" },
      { connect: fake.connect },
    );
    cleanups.push(() => bridge.close(), fake.cleanup);

    const controller = h264Peer();
    cleanups.push(() => controller.close());
    const offerSdp = await makeControllerOffer(controller);

    const start = Date.now();
    await expect(
      bridge.acceptControllerOffer(3, "camera.slow", offerSdp),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  }, 15_000);
});

describe("growRecvBuffers", () => {
  it("raises the receive buffer of the peer's UDP sockets (#373)", async () => {
    const probe = createSocket("udp4");
    await new Promise<void>((r) => probe.bind(0, "127.0.0.1", r));
    const hostDefault = probe.getRecvBufferSize();
    probe.close();

    const peer = h264Peer();
    cleanups.push(() => peer.close());
    await makeControllerOffer(peer);

    const sizes = growRecvBuffers(peer, "camera.hq");
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      if (hostDefault < UDP_RECV_BUFFER) {
        expect(size).toBeGreaterThan(hostDefault);
      } else {
        expect(size).toBe(hostDefault);
      }
    }
  }, 15_000);
});
