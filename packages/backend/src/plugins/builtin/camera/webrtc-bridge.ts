import { Logger } from "@matter/general";
import {
  type Connection,
  createConnection,
  createLongLivedTokenAuth,
} from "home-assistant-js-websocket";
import { RTCPeerConnection, type RTCRtpTransceiver } from "werift";

// Bridges an HA camera to a Matter controller. Both sides want to be the
// offerer, so we run two werift peers per session and forward the tracks.

const logger = Logger.get("CameraWebRtc");

// How long we wait for HA to answer a camera/webrtc/offer before giving up.
const DEFAULT_HA_WEBRTC_TIMEOUT_MS = 15_000;
let haWebRtcTimeoutMs = DEFAULT_HA_WEBRTC_TIMEOUT_MS;

// Test seam: shrink the HA answer timeout so the timeout path is reachable
// without a 15s wait. Production code never calls this.
export function setHaWebRtcTimeoutMsForTests(ms: number): void {
  haWebRtcTimeoutMs = ms;
}
export { DEFAULT_HA_WEBRTC_TIMEOUT_MS };

export interface WebRtcBridgeConfig {
  /** HA base URL, e.g. http://homeassistant.local:8123 */
  haUrl: string;
  /** Long-lived access token for the HA connection. */
  haToken: string;
}

export interface WebRtcBridgeDeps {
  /** Test seam: open the HA websocket. Defaults to a real long-lived dial. */
  connect?: (config: WebRtcBridgeConfig) => Promise<Connection>;
}

// Controller-supplied ICE config, mapped from the Matter ProvideOffer request.
export interface ControllerIceConfig {
  iceServers?: { urLs: string[]; username?: string; credential?: string }[];
  iceTransportPolicy?: string;
}

export interface MatterOffer {
  /** SDP offer to hand to the Matter controller (ProvideAnswer flow). */
  sdp: string;
  /** Local ICE candidates gathered for the controller peer. */
  iceCandidates: { candidate: string; sdpMid: string | null }[];
}

// Shape of the messages HA streams back on a camera/webrtc/offer subscription.
interface HaWebRtcMessage {
  type?: string;
  answer?: string;
  session_id?: string;
  code?: string;
  message?: string;
  candidate?: {
    candidate?: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };
}

interface BridgeSession {
  entityId: string;
  haPeer: RTCPeerConnection;
  controllerPeer: RTCPeerConnection;
  haSessionId?: string;
  haUnsubscribe?: () => void;
}

export class WebRtcBridge {
  private connection?: Connection;
  private readonly sessions = new Map<number, BridgeSession>();

  constructor(
    private readonly config: WebRtcBridgeConfig,
    private readonly deps: WebRtcBridgeDeps = {},
  ) {}

  private async ha(): Promise<Connection> {
    if (this.connection) return this.connection;
    if (this.deps.connect) {
      this.connection = await this.deps.connect(this.config);
    } else {
      const auth = createLongLivedTokenAuth(
        this.config.haUrl,
        this.config.haToken,
      );
      this.connection = await createConnection({ auth });
    }
    return this.connection;
  }

  // We offer to the controller; it answers. Pulls HA media first, then forwards.
  async startSession(
    matterSessionId: number,
    entityId: string,
    ice?: ControllerIceConfig,
  ): Promise<MatterOffer> {
    const haPeer = new RTCPeerConnection();
    const controllerPeer = new RTCPeerConnection(
      this.controllerConfig(entityId, ice),
    );
    this.wireStateLogging(haPeer, "haPeer", entityId);
    this.wireStateLogging(controllerPeer, "controllerPeer", entityId);

    // Pre-add the sendonly transceivers so our own offer advertises media; a
    // late addTransceiver (inside onTrack) never renegotiates and never sends.
    const senders = new Map<string, RTCRtpTransceiver>();
    // Video only: the AvStream cluster advertises no audio feature, and the
    // deferred-offer path has no controller m-lines to constrain against.
    senders.set(
      "video",
      controllerPeer.addTransceiver("video", { direction: "sendonly" }),
    );
    this.forwardHaTracks(haPeer, senders, entityId);

    this.sessions.set(matterSessionId, { entityId, haPeer, controllerPeer });

    try {
      // 1) Offer to HA so HA answers and starts sending media to us.
      haPeer.addTransceiver("video", { direction: "recvonly" });
      haPeer.addTransceiver("audio", { direction: "recvonly" });
      const haOffer = await haPeer.createOffer();
      await haPeer.setLocalDescription(haOffer);
      const haOfferSdp = this.localSdp(haPeer);
      logger.info(`HA offer sent for ${entityId} (${haOfferSdp.length} chars)`);
      const { answer, sessionId, unsubscribe } = await this.requestHaWebRtc(
        entityId,
        haOfferSdp,
        haPeer,
      );
      const session = this.sessions.get(matterSessionId);
      if (session) {
        session.haSessionId = sessionId;
        session.haUnsubscribe = unsubscribe;
      }
      await haPeer.setRemoteDescription({ type: "answer", sdp: answer });

      // 2) Build the controller-facing offer (controller will ProvideAnswer).
      const iceCandidates: { candidate: string; sdpMid: string | null }[] = [];
      controllerPeer.onIceCandidate.subscribe((c) => {
        if (c?.candidate)
          iceCandidates.push({
            candidate: c.candidate,
            sdpMid: c.sdpMid ?? null,
          });
      });
      const controllerOffer = await controllerPeer.createOffer();
      await controllerPeer.setLocalDescription(controllerOffer);
      const sdp = this.localSdp(controllerPeer);
      logger.info(
        `controller offer created for ${entityId} (${sdp.length} chars)`,
      );
      return { sdp, iceCandidates };
    } catch (err) {
      logger.info(`startSession failed for ${entityId}: ${errText(err)}`);
      await this.endSession(matterSessionId);
      throw err;
    }
  }

  // ProvideOffer flow: controller sent its offer. Pull HA media, answer it.
  // Returning the answer to the controller is the unverified Requestor path.
  async acceptControllerOffer(
    matterSessionId: number,
    entityId: string,
    controllerOfferSdp: string,
    ice?: ControllerIceConfig,
  ): Promise<string> {
    const haPeer = new RTCPeerConnection();
    const controllerPeer = new RTCPeerConnection(
      this.controllerConfig(entityId, ice),
    );
    this.wireStateLogging(haPeer, "haPeer", entityId);
    this.wireStateLogging(controllerPeer, "controllerPeer", entityId);

    // Pre-add sendonly transceivers matching the controller offer's m-lines so
    // the answer advertises media; adding them inside onTrack never connects.
    const senders = new Map<string, RTCRtpTransceiver>();
    for (const kind of offerKinds(controllerOfferSdp)) {
      senders.set(
        kind,
        controllerPeer.addTransceiver(kind, { direction: "sendonly" }),
      );
    }
    this.forwardHaTracks(haPeer, senders, entityId);

    this.sessions.set(matterSessionId, { entityId, haPeer, controllerPeer });

    try {
      // Pull media from HA (we offer, HA answers).
      haPeer.addTransceiver("video", { direction: "recvonly" });
      haPeer.addTransceiver("audio", { direction: "recvonly" });
      const haOffer = await haPeer.createOffer();
      await haPeer.setLocalDescription(haOffer);
      const haOfferSdp = this.localSdp(haPeer);
      logger.info(`HA offer sent for ${entityId} (${haOfferSdp.length} chars)`);
      const { answer, sessionId, unsubscribe } = await this.requestHaWebRtc(
        entityId,
        haOfferSdp,
        haPeer,
      );
      const session = this.sessions.get(matterSessionId);
      if (session) {
        session.haSessionId = sessionId;
        session.haUnsubscribe = unsubscribe;
      }
      await haPeer.setRemoteDescription({ type: "answer", sdp: answer });

      // Answer the controller's offer.
      await controllerPeer.setRemoteDescription({
        type: "offer",
        sdp: controllerOfferSdp,
      });
      const controllerAnswer = await controllerPeer.createAnswer();
      await controllerPeer.setLocalDescription(controllerAnswer);
      const answerSdp = this.localSdp(controllerPeer);
      logger.info(
        `controller answer created for ${entityId} (${answerSdp.length} chars)`,
      );
      return answerSdp;
    } catch (err) {
      logger.info(
        `acceptControllerOffer failed for ${entityId}: ${errText(err)}`,
      );
      await this.endSession(matterSessionId);
      throw err;
    }
  }

  /** Apply the Matter controller's SDP answer to the controller peer. */
  async acceptControllerAnswer(
    matterSessionId: number,
    sdp: string,
  ): Promise<void> {
    const session = this.sessions.get(matterSessionId);
    if (!session) return;
    logger.debug(`controller answer applied for ${session.entityId}`);
    await session.controllerPeer.setRemoteDescription({ type: "answer", sdp });
  }

  /** Add a remote ICE candidate from the Matter controller. */
  async addControllerIceCandidate(
    matterSessionId: number,
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex?: number | null,
  ): Promise<void> {
    const session = this.sessions.get(matterSessionId);
    if (!session) return;
    logger.debug(
      `controller ICE candidate for ${session.entityId}: ${candidate}`,
    );
    await session.controllerPeer.addIceCandidate({
      candidate,
      sdpMid: sdpMid ?? undefined,
      sdpMLineIndex: sdpMLineIndex ?? undefined,
    });
  }

  async endSession(matterSessionId: number): Promise<void> {
    const session = this.sessions.get(matterSessionId);
    if (!session) return;
    logger.info(`ending session ${matterSessionId} (${session.entityId})`);
    this.sessions.delete(matterSessionId);
    if (session.haUnsubscribe) {
      await Promise.resolve(session.haUnsubscribe()).catch((err) =>
        logger.debug(`HA unsubscribe failed: ${errText(err)}`),
      );
    }
    await session.haPeer.close().catch(() => {});
    await session.controllerPeer.close().catch(() => {});
    // Tell HA to stop the stream if we tracked an HA session id.
    if (session.haSessionId) {
      try {
        const conn = await this.ha();
        await conn.sendMessagePromise({
          type: "camera/webrtc/candidate",
          entity_id: session.entityId,
          session_id: session.haSessionId,
          candidate: { candidate: "" },
        });
      } catch {
        // best effort
      }
    }
  }

  // Grab a still JPEG via HA's camera proxy (for CaptureSnapshot).
  async snapshot(entityId: string): Promise<Uint8Array> {
    const url = `${this.config.haUrl}/api/camera_proxy/${entityId}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.haToken}` },
      });
    } catch (err) {
      logger.info(`snapshot fetch failed for ${entityId}: ${errText(err)}`);
      throw err;
    }
    if (!res.ok) {
      logger.info(
        `snapshot fetch failed for ${entityId}: camera_proxy ${res.status}`,
      );
      throw new Error(`HA camera_proxy ${entityId}: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.endSession(id);
    }
    this.connection?.close();
    this.connection = undefined;
  }

  // Forward every track HA sends into the matching pre-added controller sender.
  private forwardHaTracks(
    haPeer: RTCPeerConnection,
    senders: Map<string, RTCRtpTransceiver>,
    entityId: string,
  ): void {
    haPeer.onTrack.subscribe((track) => {
      logger.info(`onTrack ${track.kind} from HA (${entityId})`);
      const transceiver = senders.get(track.kind);
      if (!transceiver) {
        logger.info(
          `no controller transceiver for ${track.kind} (${entityId})`,
        );
        return;
      }
      let firstLogged = false;
      track.onReceiveRtp.subscribe((rtp) => {
        if (!firstLogged) {
          firstLogged = true;
          logger.info(`first RTP forwarded for ${track.kind} (${entityId})`);
        }
        transceiver.sender.sendRtp(rtp);
      });
    });
  }

  // Log connection/ice state transitions (these events fire on change only).
  private wireStateLogging(
    peer: RTCPeerConnection,
    label: string,
    entityId: string,
  ): void {
    peer.connectionStateChange.subscribe((s) =>
      logger.info(`${label} connectionState=${s} (${entityId})`),
    );
    peer.iceConnectionStateChange.subscribe((s) =>
      logger.info(`${label} iceConnectionState=${s} (${entityId})`),
    );
  }

  // Map the Matter ICE struct onto werift's config. Only the controller peer
  // uses controller-supplied servers; the HA peer keeps werift defaults.
  private controllerConfig(
    entityId: string,
    ice?: ControllerIceConfig,
  ): ConstructorParameters<typeof RTCPeerConnection>[0] | undefined {
    const iceServers = (ice?.iceServers ?? []).flatMap((s) =>
      (s.urLs ?? []).map((url) => ({
        urls: url,
        username: s.username,
        credential: s.credential,
      })),
    );
    if (iceServers.length === 0) {
      logger.info(`controller peer using default ICE servers (${entityId})`);
      return undefined;
    }
    const policy =
      ice?.iceTransportPolicy === "relay" || ice?.iceTransportPolicy === "all"
        ? ice.iceTransportPolicy
        : undefined;
    logger.info(
      `controller peer using ${iceServers.length} controller ICE server(s)` +
        `${policy ? ` policy=${policy}` : ""} (${entityId})`,
    );
    return policy ? { iceServers, iceTransportPolicy: policy } : { iceServers };
  }

  private localSdp(peer: RTCPeerConnection): string {
    const local = peer.localDescription;
    if (!local) throw new Error("no local description");
    return local.sdp;
  }

  // Feed an HA trickle-ICE candidate into the HA peer.
  private feedHaCandidate(
    entityId: string,
    haPeer: RTCPeerConnection,
    candidate: HaWebRtcMessage["candidate"],
  ): void {
    const value = candidate?.candidate;
    if (!value) return; // empty candidate marks end-of-candidates
    logger.debug(`HA ICE candidate for ${entityId}: ${value}`);
    void haPeer
      .addIceCandidate({
        candidate: value,
        sdpMid: candidate?.sdpMid ?? undefined,
        sdpMLineIndex: candidate?.sdpMLineIndex ?? undefined,
      })
      .catch((e) =>
        logger.debug(
          `HA addIceCandidate failed for ${entityId}: ${errText(e)}`,
        ),
      );
  }

  // Offer to HA's WebRTC and resolve on the first answer. Rejects on an error
  // reply or after a timeout; keeps the subscription open past the answer so HA
  // trickle candidates keep flowing into the HA peer until the session ends.
  private async requestHaWebRtc(
    entityId: string,
    offerSdp: string,
    haPeer: RTCPeerConnection,
  ): Promise<{ answer: string; sessionId?: string; unsubscribe: () => void }> {
    const conn = await this.ha();
    let unsubscribe: () => void = () => {};
    let sessionId: string | undefined;

    const answer = await new Promise<string>((resolve, reject) => {
      let settled = false;
      // Only rejection drops the subscription; a successful answer keeps it open
      // so HA trickle candidates keep arriving until the session ends.
      let rejected = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const fail = (err: Error): void =>
        settle(() => {
          rejected = true;
          unsubscribe();
          reject(err);
        });
      timer = setTimeout(() => {
        logger.info(
          `HA WebRTC timed out after ${haWebRtcTimeoutMs}ms for ${entityId}`,
        );
        fail(
          new Error(`HA WebRTC request timed out after ${haWebRtcTimeoutMs}ms`),
        );
      }, haWebRtcTimeoutMs);

      conn
        .subscribeMessage<HaWebRtcMessage>(
          (msg) => {
            switch (msg.type) {
              case "session":
                if (msg.session_id) sessionId = msg.session_id;
                break;
              case "answer":
                if (msg.answer) {
                  if (msg.session_id) sessionId = msg.session_id;
                  const ans = msg.answer;
                  settle(() => {
                    logger.info(
                      `HA answer received for ${entityId} (${ans.length} chars)`,
                    );
                    resolve(ans);
                  });
                }
                break;
              case "error": {
                const detail = msg.message ?? msg.code ?? "unknown error";
                logger.info(`HA WebRTC error for ${entityId}: ${detail}`);
                fail(new Error(`HA WebRTC error: ${detail}`));
                break;
              }
              case "candidate":
                this.feedHaCandidate(entityId, haPeer, msg.candidate);
                break;
            }
          },
          { type: "camera/webrtc/offer", entity_id: entityId, offer: offerSdp },
        )
        .then((unsub) => {
          unsubscribe = unsub;
          // Reject may have fired before the subscription resolved: drop it now.
          if (rejected) unsub();
        })
        .catch((err) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });
    });

    return { answer, sessionId, unsubscribe };
  }
}

// Which media kinds a remote offer advertises, so the answer matches its
// m-lines exactly (an answer must not introduce m-lines the offer lacks).
function offerKinds(sdp: string): ("video" | "audio")[] {
  // Keep the offer's m-line order; werift pairs transceivers positionally.
  const kinds: ("video" | "audio")[] = [];
  for (const m of sdp.matchAll(/^m=(video|audio)/gm)) {
    kinds.push(m[1] as "video" | "audio");
  }
  return kinds;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
