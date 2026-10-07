import { Logger, type MaybePromise } from "@matter/general";
import { EndpointNumber, type FabricIndex, NodeId } from "@matter/main";
import { WebRtcTransportProviderServer } from "@matter/main/behaviors";
import {
  WebRtcTransportDefinitions,
  type WebRtcTransportProvider,
} from "@matter/main/clusters";
import type { SecureSession } from "@matter/protocol";
import { StreamUsage } from "@matter/types";
import { CameraAvStreamServer } from "./av-stream-server.js";
import {
  deliverAnswerDeferred,
  hasRequestor,
  registerRequestor,
  sendEnd,
  unregisterRequestor,
} from "./requestor-client.js";
import type { WebRtcBridge } from "./webrtc-bridge.js";

const logger = Logger.get("CameraWebRtc");

// Session ids mint globally: the requestor registry and the bridge session map
// are process wide, per-endpoint counters would collide across cameras.
// Per spec the counter wraps past 65534 to 0 and must probe past live ids.
let nextGlobalSessionId = 0;
function mintSessionId(): number {
  for (let i = 0; i <= 0xfffe; i++) {
    const id = nextGlobalSessionId;
    nextGlobalSessionId =
      nextGlobalSessionId >= 0xfffe ? 0 : nextGlobalSessionId + 1;
    if (!hasRequestor(id)) return id;
  }
  // 65535 live sessions cannot happen, but never loop forever.
  return nextGlobalSessionId;
}

// The 5 WebRtcTransportProvider commands, media delegated to WebRtcBridge.
// provideOffer is wired; solicitOffer's deferred-offer push is unverified.
export class CameraWebRtcProviderServer extends WebRtcTransportProviderServer {
  declare state: CameraWebRtcProviderServer.State;

  override solicitOffer(
    request: WebRtcTransportProvider.SolicitOfferRequest,
  ): MaybePromise<WebRtcTransportProvider.SolicitOfferResponse> {
    const id = mintSessionId();
    const videoStreams = this.videoStreamsFor(request, request.streamUsage);
    this.trackSession(
      id,
      request.streamUsage,
      request.originatingEndpointId,
      videoStreams,
    );
    logger.info(
      `solicitOffer session=${id} (${this.state.entityId}), deferred offer`,
    );
    // deferredOffer: the offer is delivered later via WebRtcTransportRequestor
    // (camera -> controller). That client-side push is not wired yet.
    void this.state.bridge
      .startSession(id, this.state.entityId, {
        iceServers: request.iceServers,
        iceTransportPolicy: request.iceTransportPolicy,
      })
      .catch((err) =>
        logger.info(
          `solicitOffer startSession failed for ${this.state.entityId}: ${errText(err)}`,
        ),
      );
    return {
      webRtcSessionId: id,
      deferredOffer: true,
      ...echoStreamIds(request, videoStreams),
    };
  }

  override provideOffer(
    request: WebRtcTransportProvider.ProvideOfferRequest,
  ): WebRtcTransportProvider.ProvideOfferResponse {
    const id = request.webRtcSessionId ?? mintSessionId();
    const entityId = this.state.entityId;
    logger.info(
      `provideOffer entry: entityId=${entityId} session=${id} (sdp ${request.sdp.length} chars)`,
    );
    const isNew = request.webRtcSessionId == null;
    const videoStreams = isNew
      ? this.videoStreamsFor(
          request,
          request.streamUsage ?? StreamUsage.LiveView,
        )
      : this.reofferStreams(id, request);
    if (isNew) {
      this.trackSession(
        id,
        request.streamUsage ?? StreamUsage.LiveView,
        request.originatingEndpointId ?? EndpointNumber(0),
        videoStreams,
      );
    }
    // Register the live session so we can invoke the answer back on the
    // controller's WebRtcTransportRequestor cluster once the bridge answers.
    const session = (this.context as unknown as { session?: SecureSession })
      .session;
    if (session) {
      registerRequestor(id, {
        session,
        requestorEndpoint: request.originatingEndpointId ?? EndpointNumber(0),
        env: this.env,
        // The bridge instance scopes this session to its camera plugin.
        owner: this.state.bridge,
      });
    }
    // Answer now and negotiate after the commit. Pulling HA's stream and
    // gathering ICE takes seconds, CHIP based controllers only wait about 2 s
    // for an invoke response; the answer SDP follows on the requestor.
    const bridge = this.state.bridge;
    const state = this.state;
    const ice = {
      iceServers: request.iceServers,
      iceTransportPolicy: request.iceTransportPolicy,
    };
    const offerSdp = request.sdp;
    const cleanup = async () => {
      await bridge.endSession(id).catch(() => {});
      unregisterRequestor(id);
      try {
        state.currentSessions = state.currentSessions.filter(
          (s) => s.id !== id,
        );
      } catch {
        // endpoint already disposed, nothing left to prune
      }
    };
    this.context.transaction.onFinalize(() =>
      answerOffer(id, entityId, bridge, offerSdp, ice, cleanup),
    );
    return {
      webRtcSessionId: id,
      ...echoStreamIds(request, videoStreams),
    };
  }

  override provideAnswer(
    request: WebRtcTransportProvider.ProvideAnswerRequest,
  ): MaybePromise {
    logger.info(
      `provideAnswer session=${request.webRtcSessionId} (sdp ${request.sdp.length} chars, ${this.state.entityId})`,
    );
    return this.state.bridge.acceptControllerAnswer(
      request.webRtcSessionId,
      request.sdp,
    );
  }

  override async provideIceCandidates(
    request: WebRtcTransportProvider.ProvideIceCandidatesRequest,
  ): Promise<void> {
    logger.info(
      `provideIceCandidates session=${request.webRtcSessionId}: ${request.iceCandidates.length} candidate(s) (${this.state.entityId})`,
    );
    for (const c of request.iceCandidates) {
      await this.state.bridge.addControllerIceCandidate(
        request.webRtcSessionId,
        c.candidate,
        c.sdpMid,
        c.sdpmLineIndex,
      );
    }
  }

  override async endSession(
    request: WebRtcTransportProvider.EndSessionRequest,
  ): Promise<void> {
    logger.info(
      `endSession session=${request.webRtcSessionId} (${this.state.entityId})`,
    );
    await this.state.bridge.endSession(request.webRtcSessionId);
    unregisterRequestor(request.webRtcSessionId);
    this.state.currentSessions = this.state.currentSessions.filter(
      (s) => s.id !== request.webRtcSessionId,
    );
  }

  // The streams a request names (VideoStreams, or the older VideoStreamID),
  // else one picked or allocated for its usage.
  private videoStreamsFor(
    request: { videoStreamId?: number | null; videoStreams?: number[] },
    streamUsage: StreamUsage,
  ): number[] {
    if (request.videoStreams?.length) return request.videoStreams;
    if (request.videoStreamId != null) return [request.videoStreamId];
    return [this.agent.get(CameraAvStreamServer).videoStreamFor(streamUsage)];
  }

  // A re-offer keeps the streams of the session it renegotiates.
  private reofferStreams(
    id: number,
    request: { videoStreamId?: number | null; videoStreams?: number[] },
  ): number[] {
    if (request.videoStreams?.length) return request.videoStreams;
    if (request.videoStreamId != null) return [request.videoStreamId];
    return (
      this.state.currentSessions.find((s) => s.id === id)?.videoStreams ?? []
    );
  }

  private trackSession(
    id: number,
    streamUsage: StreamUsage,
    peerEndpointId: EndpointNumber,
    videoStreams: number[],
  ): void {
    // Commands run online, so a session exists; read it structurally because
    // the public context type also covers the offline case.
    const session = (
      this.context as unknown as {
        session?: {
          peerNodeId?: NodeId;
          associatedFabric?: { fabricIndex: FabricIndex };
        };
      }
    ).session;
    const fabricIndex = session?.associatedFabric?.fabricIndex;
    if (fabricIndex == null) {
      // No fabric (offline act in tests): a 0 sentinel fails validation.
      return;
    }
    this.state.currentSessions = [
      ...this.state.currentSessions,
      {
        id,
        peerNodeId: session?.peerNodeId ?? NodeId(0),
        peerEndpointId,
        streamUsage,
        // Matter 1.5 needs at least one stream list, or the write fails with
        // ConstraintError and the controller never gets an answer
        videoStreams,
        videoStreamId: videoStreams[0],
        metadataEnabled: false,
        fabricIndex,
      },
    ];
  }
}

// A request with the older VideoStreamID/AudioStreamID fields gets them back
// in the response. There is no audio stream, the camera has no Audio feature.
function echoStreamIds(
  request: {
    videoStreamId?: number | null;
    audioStreamId?: number | null;
  },
  videoStreams: number[],
): { videoStreamId?: number | null; audioStreamId?: null } {
  return {
    ...(request.videoStreamId === undefined
      ? {}
      : { videoStreamId: videoStreams[0] ?? null }),
    ...(request.audioStreamId === undefined ? {} : { audioStreamId: null }),
  };
}

// Pull HA's stream and answer the controller's offer over the requestor. When
// HA can't deliver, tell the controller with End so it stops waiting.
async function answerOffer(
  id: number,
  entityId: string,
  bridge: WebRtcBridge,
  offerSdp: string,
  ice: Parameters<WebRtcBridge["acceptControllerOffer"]>[3],
  cleanup: () => Promise<void>,
): Promise<void> {
  let answerSdp: string;
  try {
    answerSdp = await bridge.acceptControllerOffer(id, entityId, offerSdp, ice);
  } catch (err) {
    logger.info(
      `provideOffer failed for ${entityId} session=${id}: ${errText(err)}`,
    );
    await sendEnd(id, WebRtcTransportDefinitions.WebRtcEndReason.NoUserMedia);
    await cleanup();
    return;
  }
  logger.info(
    `provideOffer answer computed for ${entityId} session=${id} (${answerSdp.length} chars); delivering via requestor`,
  );
  // The answer SDP already embeds our gathered candidates (werift blocks on
  // ICE gathering in setLocalDescription), no ICE trickle needed.
  deliverAnswerDeferred(id, answerSdp, cleanup);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export namespace CameraWebRtcProviderServer {
  export class State extends WebRtcTransportProviderServer.State {
    bridge!: WebRtcBridge;
    entityId!: string;
  }
}
