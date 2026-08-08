import { Logger, type MaybePromise } from "@matter/general";
import { EndpointNumber, type FabricIndex, NodeId } from "@matter/main";
import { WebRtcTransportProviderServer } from "@matter/main/behaviors";
import type { WebRtcTransportProvider } from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import type { SecureSession } from "@matter/protocol";
import { StreamUsage } from "@matter/types";
import {
  deliverAnswerDeferred,
  hasRequestor,
  registerRequestor,
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
    this.trackSession(id, request.streamUsage, request.originatingEndpointId);
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
    return { webRtcSessionId: id, deferredOffer: true };
  }

  override async provideOffer(
    request: WebRtcTransportProvider.ProvideOfferRequest,
  ): Promise<WebRtcTransportProvider.ProvideOfferResponse> {
    const id = request.webRtcSessionId ?? mintSessionId();
    logger.info(
      `provideOffer entry: entityId=${this.state.entityId} session=${id} (sdp ${request.sdp.length} chars)`,
    );
    if (request.webRtcSessionId == null) {
      this.trackSession(
        id,
        request.streamUsage ?? StreamUsage.LiveView,
        request.originatingEndpointId ?? EndpointNumber(0),
      );
    }
    // Register the live session so we can invoke the answer back on the
    // controller's WebRtcTransportRequestor cluster once the bridge answers.
    const requestorEndpoint =
      request.originatingEndpointId ?? EndpointNumber(0);
    const session = (this.context as unknown as { session?: SecureSession })
      .session;
    if (session) {
      registerRequestor(id, {
        session,
        requestorEndpoint,
        env: this.env,
      });
    }
    let answerSdp: string;
    try {
      answerSdp = await this.state.bridge.acceptControllerOffer(
        id,
        this.state.entityId,
        request.sdp,
        {
          iceServers: request.iceServers,
          iceTransportPolicy: request.iceTransportPolicy,
        },
      );
    } catch (err) {
      const message = errText(err);
      logger.info(
        `provideOffer failed for ${this.state.entityId} session=${id}: ${message}`,
      );
      // Drop the half-open session we optimistically tracked.
      unregisterRequestor(id);
      this.state.currentSessions = this.state.currentSessions.filter(
        (s) => s.id !== id,
      );
      throw new StatusResponseError(
        `WebRTC offer failed: ${message}`,
        StatusCode.Failure,
      );
    }
    logger.info(
      `provideOffer answer computed for ${this.state.entityId} session=${id} (${answerSdp.length} chars); delivering via requestor`,
    );
    // Deliver AFTER this handler returns. The answer SDP already embeds our
    // gathered host candidates (werift blocks on ICE gathering in
    // setLocalDescription), no ICE trickle needed. No agent context survives
    // the timer, so capture plain values.
    const bridge = this.state.bridge;
    const state = this.state;
    deliverAnswerDeferred(id, answerSdp, async () => {
      await bridge.endSession(id).catch(() => {});
      unregisterRequestor(id);
      try {
        state.currentSessions = state.currentSessions.filter(
          (s) => s.id !== id,
        );
      } catch {
        // endpoint already disposed, nothing left to prune
      }
    });
    return { webRtcSessionId: id };
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

  private trackSession(
    id: number,
    streamUsage: StreamUsage,
    peerEndpointId: EndpointNumber,
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
        metadataEnabled: false,
        fabricIndex,
      },
    ];
  }
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
