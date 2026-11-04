import { Logger, type MaybePromise, Transaction } from "@matter/general";
import { EndpointNumber, type FabricIndex, NodeId } from "@matter/main";
import { WebRtcTransportProviderServer } from "@matter/main/behaviors";
import {
  WebRtcTransportDefinitions,
  type WebRtcTransportProvider,
} from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import type { SecureSession } from "@matter/protocol";
import { StreamUsage } from "@matter/types";
import { errText } from "../../../utils/err-text.js";
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
// Only provideOffer is wired, solicitOffer is refused.
export class CameraWebRtcProviderServer extends WebRtcTransportProviderServer {
  declare state: CameraWebRtcProviderServer.State;

  override async initialize() {
    await super.initialize();
    // wait for the AV state lock, a snapshot invoke holds it while HA answers
    const av = this.agent.get(CameraAvStreamServer);
    this.reactTo(this.events.currentSessions$Changed, this.countAudioUse, {
      offline: true,
      lock: [av[Transaction.Resource.reference] as Transaction.Resource],
    });
  }

  // Nothing pushes an Offer to the requestor yet, a session started here would
  // stream into nowhere. SmartThings, HA and CHIP controllers send ProvideOffer.
  override solicitOffer(): WebRtcTransportProvider.SolicitOfferResponse {
    logger.info(`solicitOffer refused (${this.state.entityId})`);
    throw new StatusResponseError(
      "SolicitOffer is not supported, use ProvideOffer",
      StatusCode.ResourceExhausted,
    );
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
    const audioStreams = isNew
      ? this.audioStreamsFor(
          request,
          request.streamUsage ?? StreamUsage.LiveView,
          request.sdp,
        )
      : this.reofferAudioStreams(id, request);
    if (isNew) {
      this.trackSession(
        id,
        request.streamUsage ?? StreamUsage.LiveView,
        request.originatingEndpointId ?? EndpointNumber(0),
        videoStreams,
        audioStreams,
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
    const endpoint = this.endpoint;
    const ice = {
      iceServers: request.iceServers,
      iceTransportPolicy: request.iceTransportPolicy,
    };
    const offerSdp = request.sdp;
    const cleanup = async () => {
      await bridge.endSession(id).catch(() => {});
      unregisterRequestor(id);
      // this command's state expires with its transaction, prune in a new one
      try {
        await endpoint.act((agent) => {
          const { state } = agent.get(CameraWebRtcProviderServer);
          state.currentSessions = state.currentSessions.filter(
            (s) => s.id !== id,
          );
        });
      } catch (err) {
        // endpoint already disposed, nothing left to prune
        logger.debug(`session=${id} not pruned (${entityId}): ${errText(err)}`);
      }
    };
    this.context.transaction.onFinalize(() =>
      answerOffer(id, entityId, bridge, offerSdp, ice, cleanup),
    );
    return {
      webRtcSessionId: id,
      ...echoStreamIds(request, videoStreams, audioStreams),
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

  // The audio streams a request names, checked against the allocated ones. Null
  // asks for a stream to be assigned or created. A new offer naming none still
  // gets HA's audio when its SDP has an audio m-line: SmartThings live view
  // (#373) sends no audio id and plays the sound, the spec only says should
  // not. Both list the usage's stream if one exists but never allocate: a
  // snapshot invoke can hold the AV state and the write would fail the offer.
  private audioStreamsFor(
    request: { audioStreamId?: number | null; audioStreams?: number[] },
    streamUsage: StreamUsage,
    sdp: string,
  ): number[] {
    const av = this.agent.get(CameraAvStreamServer);
    const named = request.audioStreams?.length
      ? request.audioStreams
      : request.audioStreamId != null
        ? [request.audioStreamId]
        : undefined;
    if (named) {
      av.checkAudioStreams(named);
      return named;
    }
    const existing =
      request.audioStreamId === null || /^m=audio/m.test(sdp)
        ? av.audioStreamOf(streamUsage)
        : undefined;
    return existing === undefined ? [] : [existing];
  }

  private reofferAudioStreams(
    id: number,
    request: { audioStreamId?: number | null; audioStreams?: number[] },
  ): number[] {
    if (request.audioStreams?.length) return request.audioStreams;
    if (request.audioStreamId != null) return [request.audioStreamId];
    return (
      this.state.currentSessions.find((s) => s.id === id)?.audioStreams ?? []
    );
  }

  private countAudioUse() {
    this.agent
      .get(CameraAvStreamServer)
      .countAudioUse(
        this.state.currentSessions.flatMap((s) => s.audioStreams ?? []),
      );
  }

  private trackSession(
    id: number,
    streamUsage: StreamUsage,
    peerEndpointId: EndpointNumber,
    videoStreams: number[],
    audioStreams: number[],
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
        ...(audioStreams.length
          ? { audioStreams, audioStreamId: audioStreams[0] }
          : {}),
        metadataEnabled: false,
        fabricIndex,
      },
    ];
  }
}

// A request with the older VideoStreamID/AudioStreamID fields gets them back
// in the response.
function echoStreamIds(
  request: {
    videoStreamId?: number | null;
    audioStreamId?: number | null;
  },
  videoStreams: number[],
  audioStreams: number[],
): { videoStreamId?: number | null; audioStreamId?: number | null } {
  return {
    ...(request.videoStreamId === undefined
      ? {}
      : { videoStreamId: videoStreams[0] ?? null }),
    ...(request.audioStreamId === undefined
      ? {}
      : { audioStreamId: audioStreams[0] ?? null }),
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
    answerSdp = await bridge.acceptControllerOffer(
      id,
      entityId,
      offerSdp,
      ice,
      cleanup,
    );
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

export namespace CameraWebRtcProviderServer {
  export class State extends WebRtcTransportProviderServer.State {
    bridge!: WebRtcBridge;
    entityId!: string;
  }
}
