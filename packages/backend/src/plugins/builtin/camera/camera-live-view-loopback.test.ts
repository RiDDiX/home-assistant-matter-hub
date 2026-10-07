// A matter.js controller on loopback plays SmartThings: it allocates a video
// stream, sends ProvideOffer with the SDP shape SmartThings' camera driver
// declares (audio sendrecv first, video recvonly, BUNDLE) and waits for the
// camera's Answer on its own WebRtcTransportRequestor cluster. A werift peer
// stands in for HA and sends video and audio. Off by default, needs common
// built and network for werift's STUN gathering:
//   HAMH_LOOPBACK=1 npx vitest run camera-live-view-loopback
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, Endpoint, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";
import {
  CameraAvStreamManagement,
  WebRtcTransportProvider,
} from "@matter/main/clusters";
import { CameraControllerDevice } from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { Invoke } from "@matter/main/protocol";
import { StreamUsage } from "@matter/types";
import type { Connection } from "home-assistant-js-websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useH264,
  useOPUS,
  usePCMU,
} from "werift";
import { AggregatorEndpoint } from "../../../matter/endpoints/aggregator-endpoint.js";
import { createCameraEndpointType } from "./camera-endpoint.js";
import { CAMERA_TCP_CONFIG } from "./camera-tcp-requirement.js";
import { WebRtcBridge } from "./webrtc-bridge.js";

let dir: string;
let env: Environment;
let device: ServerNode | undefined;
let controller: ServerNode | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-camera-loopback-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    try {
      await c();
    } catch {
      // best effort
    }
  }
  await controller?.close().catch(() => {});
  await device?.close().catch(() => {});
  controller = device = undefined;
  rmSync(dir, { recursive: true, force: true });
});
const delay = (n: number) => new Promise((r) => setTimeout(r, n));

// HA side: answers the bridge's offer with a werift peer sending video + audio.
function fakeHa() {
  const timers: ReturnType<typeof setInterval>[] = [];
  const peers: RTCPeerConnection[] = [];
  let unsubscribed = 0;
  const connect = async (): Promise<Connection> =>
    ({
      async subscribeMessage(
        callback: (msg: unknown) => void,
        message: { offer?: string },
      ) {
        // go2rtc relays an H.264 camera as H.264, it does not transcode
        const pc = new RTCPeerConnection({
          codecs: { video: [useH264()], audio: [useOPUS()] },
        });
        peers.push(pc);
        const video = new MediaStreamTrack({ kind: "video" });
        const audio = new MediaStreamTrack({ kind: "audio" });
        // match the bridge's HA offer order: video, then audio
        pc.addTransceiver(video, { direction: "sendonly" });
        pc.addTransceiver(audio, { direction: "sendonly" });
        await pc.setRemoteDescription({
          type: "offer",
          sdp: message.offer ?? "",
        });
        await pc.setLocalDescription(await pc.createAnswer());
        queueMicrotask(() => {
          callback({ type: "session", session_id: "ha-1" });
          callback({ type: "answer", answer: pc.localDescription?.sdp });
        });
        let seq = 1;
        timers.push(
          setInterval(() => {
            seq++;
            video.writeRtp(
              new RtpPacket(
                new RtpHeader({
                  payloadType: 96,
                  sequenceNumber: seq & 0xffff,
                  timestamp: seq * 3000,
                  ssrc: 1111,
                }),
                Buffer.alloc(200, 1),
              ),
            );
            audio.writeRtp(
              new RtpPacket(
                new RtpHeader({
                  payloadType: 111,
                  sequenceNumber: seq & 0xffff,
                  timestamp: seq * 960,
                  ssrc: 2222,
                }),
                Buffer.alloc(60, 2),
              ),
            );
          }, 20),
        );
        return async () => {
          unsubscribed++;
        };
      },
      async sendMessagePromise() {
        return undefined;
      },
      close() {},
    }) as unknown as Connection;
  const cleanup = async () => {
    for (const t of timers) clearInterval(t);
    for (const p of peers) await p.close().catch(() => {});
  };
  return { connect, cleanup, unsubscribedCount: () => unsubscribed };
}

async function invoke(
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  client: any,
  endpoint: number,
  cluster: unknown,
  command: string,
  fields: unknown,
) {
  const out: { status?: number; data?: unknown }[] = [];
  const result = client.interaction.invoke(
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
    Invoke({ commands: [{ endpoint, cluster, command, fields } as any] }),
  );
  for await (const chunk of result) {
    for (const entry of chunk) {
      if (entry.kind === "cmd-response") out.push({ data: entry.data });
      if (entry.kind === "cmd-status") out.push({ status: entry.status });
    }
  }
  return out;
}

async function bringUp() {
  const ha = fakeHa();
  cleanups.push(ha.cleanup);
  const bridge = new WebRtcBridge(
    { haUrl: "http://ha", haToken: "t" },
    { connect: ha.connect },
  );
  cleanups.push(() => bridge.close());

  device = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "camera-device",
    // what a bridge with cameras runs with (#419)
    network: { port: 0, tcp: CAMERA_TCP_CONFIG },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await device.add(aggregator);
  const camera = new Endpoint(
    createCameraEndpointType(bridge, "camera.front")
      .with(BridgedDeviceBasicInformationServer)
      .set({ bridgedDeviceBasicInformation: { nodeLabel: "Front" } }),
    { id: "plugin_camera_front" },
  );
  await aggregator.add(camera);
  await device.start();
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  const port = (device.state as any).network.operationalPort as number;

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "camera-controller",
      network: { port: 0, tcp: { incoming: false, outgoing: true } },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  const requestor = new Endpoint(CameraControllerDevice, { id: "requestor" });
  await controller.add(requestor);
  await controller.start();

  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: "camera",
    D: 3840,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: 20202021,
    discriminator: 3840,
    autoSubscribe: false,
    autoStateInitialize: false,
  });
  return { ha, camera, requestor, client };
}

// The offer SmartThings' camera driver declares: audio sendrecv first, then
// video recvonly, bundled (matter-switch camera_utils/device_configuration.lua).
async function smartThingsPlayer() {
  // Matter cameras stream H.264
  const player = new RTCPeerConnection({
    codecs: { video: [useH264()], audio: [useOPUS(), usePCMU()] },
  });
  cleanups.push(() => player.close());
  const counts = { video: 0, audio: 0 };
  player.onTrack.subscribe((t) =>
    t.onReceiveRtp.subscribe(() => {
      counts[t.kind as "video" | "audio"]++;
    }),
  );
  player.addTransceiver("audio", { direction: "sendrecv" });
  player.addTransceiver("video", { direction: "recvonly" });
  await player.setLocalDescription(await player.createOffer());
  return { player, counts, offer: player.localDescription?.sdp ?? "" };
}

describe.skipIf(!process.env.HAMH_LOOPBACK)(
  "camera live view over loopback",
  () => {
    it(
      "answers a SmartThings-shaped offer over the requestor and streams video",
      { timeout: 120_000 },
      async () => {
        const { ha, camera, requestor, client } = await bringUp();

        const answers: string[] = [];
        // biome-ignore lint/suspicious/noExplicitAny: behavior events
        (requestor.events as any).webRtcTransportRequestor.answer.on(
          (_s: unknown, sdp: string) => answers.push(sdp),
        );

        const alloc = await invoke(
          client,
          camera.number,
          CameraAvStreamManagement.Cluster,
          "videoStreamAllocate",
          {
            streamUsage: StreamUsage.LiveView,
            videoCodec: CameraAvStreamManagement.VideoCodec.H264,
            minFrameRate: 15,
            maxFrameRate: 30,
            minResolution: { width: 640, height: 360 },
            maxResolution: { width: 1920, height: 1080 },
            minBitRate: 10_000,
            maxBitRate: 4_000_000,
            keyFrameInterval: 4000,
            // SmartThings always sends these (capability_handlers.lua)
            watermarkEnabled: false,
            osdEnabled: false,
          },
        );
        // biome-ignore lint/suspicious/noExplicitAny: response shape
        const videoStreamId = (alloc[0]?.data as any)?.videoStreamId;
        expect(videoStreamId).toBeDefined();

        const { player, counts, offer } = await smartThingsPlayer();
        expect(offer.indexOf("m=audio")).toBeLessThan(offer.indexOf("m=video"));
        expect(offer).toMatch(/a=group:BUNDLE/);

        const t0 = Date.now();
        const res = await invoke(
          client,
          camera.number,
          WebRtcTransportProvider.Cluster,
          "provideOffer",
          {
            webRtcSessionId: null,
            sdp: offer,
            streamUsage: StreamUsage.LiveView,
            originatingEndpointId: requestor.number,
            videoStreamId,
            audioStreamId: null,
          },
        );
        // biome-ignore lint/suspicious/noExplicitAny: response shape
        const sessionId = (res[0]?.data as any)?.webRtcSessionId;
        expect(sessionId).toBeDefined();
        // CHIP SDK controllers give an invoke round trip + 2 s by default
        // (kExpectedIMProcessingTime), the answer follows on the requestor
        const responseMs = Date.now() - t0;
        expect(responseMs).toBeLessThan(2000);

        // SmartThings registers the session once it knows the id.
        // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
        const anyClient = client as any;
        const peer =
          anyClient.peerAddress ?? anyClient.state.commissioning?.peerAddress;
        await requestor.act((agent) =>
          // biome-ignore lint/suspicious/noExplicitAny: behavior API
          (agent as any).webRtcTransportRequestor.upsertSession({
            id: sessionId,
            peerNodeId: peer.nodeId,
            peerEndpointId: camera.number,
            streamUsage: StreamUsage.LiveView,
            videoStreams: [videoStreamId],
            metadataEnabled: false,
            fabricIndex: peer.fabricIndex,
          }),
        );

        const deadline = Date.now() + 30_000;
        while (answers.length === 0 && Date.now() < deadline) await delay(25);
        const answerMs = Date.now() - t0;
        expect(answers).toHaveLength(1);
        const answer = answers[0];
        // audio m-line first like the offer, video sendonly toward the player
        expect(answer.indexOf("m=audio")).toBeLessThan(
          answer.indexOf("m=video"),
        );
        expect(answer).toMatch(/a=sendonly/);

        await player.setRemoteDescription({ type: "answer", sdp: answer });
        const mediaDeadline = Date.now() + 15_000;
        while (counts.video === 0 && Date.now() < mediaDeadline)
          await delay(25);
        console.log(`provideOffer response after ${responseMs} ms`);
        console.log(
          `answer after ${answerMs} ms, video rtp ${counts.video}, audio rtp ${counts.audio}`,
        );
        expect(counts.video).toBeGreaterThan(0);
        expect(counts.audio).toBeGreaterThan(0);

        const end = await invoke(
          client,
          camera.number,
          WebRtcTransportProvider.Cluster,
          "endSession",
          { webRtcSessionId: sessionId, reason: 0 },
        );
        expect(end[0]?.status ?? 0).toBe(0);
        expect(ha.unsubscribedCount()).toBe(1);
      },
    );
  },
);
