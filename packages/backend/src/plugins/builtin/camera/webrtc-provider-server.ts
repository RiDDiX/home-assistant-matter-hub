import { Logger, type MaybePromise } from "@matter/general";
import { EndpointNumber, FabricIndex, NodeId } from "@matter/main";
import { WebRtcTransportProviderServer } from "@matter/main/behaviors";
import type { WebRtcTransportProvider } from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import { StreamUsage } from "@matter/types";
import type { WebRtcBridge } from "./webrtc-bridge.js";

const logger = Logger.get("CameraWebRtc");

// The 5 WebRtcTransportProvider commands, media delegated to WebRtcBridge.
// provideOffer is wired; solicitOffer's deferred-offer push is unverified.
export class CameraWebRtcProviderServer extends WebRtcTransportProviderServer {
  declare state: CameraWebRtcProviderServer.State;

  override solicitOffer(
    request: WebRtcTransportProvider.SolicitOfferRequest,
  ): MaybePromise<WebRtcTransportProvider.SolicitOfferResponse> {
    const id = this.state.nextSessionId++;
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
    const id = request.webRtcSessionId ?? this.state.nextSessionId++;
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
      this.state.currentSessions = this.state.currentSessions.filter(
        (s) => s.id !== id,
      );
      throw new StatusResponseError(
        `WebRTC offer failed: ${message}`,
        StatusCode.Failure,
      );
    }
    logger.info(
      `provideOffer answer computed for ${this.state.entityId} session=${id} (${answerSdp.length} chars); awaiting requestor delivery path`,
    );
    // Spec returns the answer via the Requestor side, which matter.js does not
    // model here. The bridge holds it; this delivery path is unverified.
    void answerSdp;
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
    this.state.currentSessions = [
      ...this.state.currentSessions,
      {
        id,
        peerNodeId: session?.peerNodeId ?? NodeId(0),
        peerEndpointId,
        streamUsage,
        metadataEnabled: false,
        fabricIndex: session?.associatedFabric?.fabricIndex ?? FabricIndex(0),
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
    nextSessionId = 1;
  }
}
