import { type Environment, Logger } from "@matter/general";
import type { EndpointNumber } from "@matter/main";
import { WebRtcTransportRequestor } from "@matter/main/clusters";
import { Status } from "@matter/main/types";
import {
  ClientInteraction,
  DedicatedChannelExchangeProvider,
  ExchangeManager,
  Invoke,
  type SecureSession,
} from "@matter/protocol";

// Per Matter 11.6 the camera drives the live-view handshake by invoking commands
// on the CONTROLLER's WebRtcTransportRequestor cluster. matter.js models the
// device as a server, so we reach back over the controller's existing secure
// session with a one-off ClientInteraction. Sessions are per-transaction, so the
// live session reference lives here in a module registry, never in behavior state.

const logger = Logger.get("CameraWebRtcRequestor");

export interface RequestorRegistration {
  /** The controller's live secure session the ProvideOffer arrived on. */
  session: SecureSession;
  /** Endpoint on the controller that hosts the WebRtcTransportRequestor cluster. */
  requestorEndpoint: EndpointNumber;
  /** Node environment, source of the ExchangeManager. */
  env: Environment;
}

export type RequestorCommand = "answer" | "iceCandidates" | "end";

export interface RequestorIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpmLineIndex: number | null;
}

// The command request handed to Invoke({ commands: [...] }); shape mirrors the
// matter.js client command request (cluster + command + endpoint + fields).
export interface RequestorCommandRequest {
  endpoint: EndpointNumber;
  cluster: typeof WebRtcTransportRequestor.Cluster;
  command: RequestorCommand;
  fields: Record<string, unknown>;
}

export interface RequestorInvocation {
  registration: RequestorRegistration;
  request: RequestorCommandRequest;
}

// Test seam: perform a single invoke against the controller, resolve true on a
// Success status. Production wires the real matter.js client stack below.
export type RequestorInvoke = (
  invocation: RequestorInvocation,
) => Promise<boolean>;

const registry = new Map<number, RequestorRegistration>();
// Pending deferred answer deliveries, cancelled when a session unregisters.
const pendingDeliveries = new Map<number, ReturnType<typeof setTimeout>>();

let invokeTransport: RequestorInvoke = defaultInvoke;

/** Track a controller session so later answer/ice/end can reach it. */
export function registerRequestor(
  sessionId: number,
  registration: RequestorRegistration,
): void {
  // Overwrite is fine: the session lifetime is owned by matter.js, not us, so
  // there is nothing to close when a session id is re-registered.
  registry.set(sessionId, registration);
}

export function unregisterRequestor(sessionId: number): void {
  registry.delete(sessionId);
  const timer = pendingDeliveries.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingDeliveries.delete(sessionId);
  }
}

/** Drop every registration and pending delivery, for plugin teardown. */
export function unregisterAllRequestors(): void {
  for (const id of [...registry.keys()]) unregisterRequestor(id);
  for (const timer of pendingDeliveries.values()) clearTimeout(timer);
  pendingDeliveries.clear();
}

/**
 * Deliver the answer after the ProvideOfferResponse went out: the controller
 * learns the minted session id from the response, so the Answer invoke must
 * not race ahead of it. Retries cover the response transmission window; when
 * every attempt fails, onGiveUp tears the media session down. Cancelled by
 * unregisterRequestor.
 */
export function deliverAnswerDeferred(
  sessionId: number,
  sdp: string,
  onGiveUp: () => Promise<void>,
): void {
  // A re-offer for the same id supersedes any delivery still in flight.
  const prior = pendingDeliveries.get(sessionId);
  if (prior) clearTimeout(prior);
  // Ownership token: the retry loop only acts while THIS registration and
  // THIS timer still own the id, so a superseding offer silences the old loop.
  const owner = registry.get(sessionId);
  const timer = setTimeout(() => {
    void (async () => {
      try {
        for (const delayMs of [0, 250, 500]) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (
            registry.get(sessionId) !== owner ||
            pendingDeliveries.get(sessionId) !== timer
          ) {
            return;
          }
          if (await sendAnswer(sessionId, sdp)) {
            logger.info(`answer delivered for session ${sessionId}`);
            return;
          }
        }
        if (
          registry.get(sessionId) !== owner ||
          pendingDeliveries.get(sessionId) !== timer
        ) {
          return;
        }
        logger.info(
          `answer delivery failed for session ${sessionId}, giving up`,
        );
        await onGiveUp();
      } catch (err) {
        logger.info(
          `answer delivery for session ${sessionId} threw: ${errText(err)}`,
        );
      } finally {
        if (pendingDeliveries.get(sessionId) === timer) {
          pendingDeliveries.delete(sessionId);
        }
      }
    })();
  }, 0);
  (timer as { unref?: () => void }).unref?.();
  pendingDeliveries.set(sessionId, timer);
}

/** Whether a live registration holds this session id (for id probing). */
export function hasRequestor(sessionId: number): boolean {
  return registry.has(sessionId);
}

/** Deliver the SDP answer for the ProvideOffer flow (§ 11.6.5.2). */
export function sendAnswer(sessionId: number, sdp: string): Promise<boolean> {
  return invokeRequestor(sessionId, "answer", {
    webRtcSessionId: sessionId,
    sdp,
  });
}

/** Trickle local ICE candidates to the controller (§ 11.6.5.3). */
export function sendIceCandidates(
  sessionId: number,
  candidates: RequestorIceCandidate[],
): Promise<boolean> {
  return invokeRequestor(sessionId, "iceCandidates", {
    webRtcSessionId: sessionId,
    iceCandidates: candidates,
  });
}

/** Tell the controller the provider ended the session (§ 11.6.5.4). */
export function sendEnd(sessionId: number, reason: number): Promise<boolean> {
  return invokeRequestor(sessionId, "end", {
    webRtcSessionId: sessionId,
    reason,
  });
}

/** Swap the invoke transport for tests; pass undefined to restore production. */
export function setRequestorInvokeForTests(
  fn: RequestorInvoke | undefined,
): void {
  invokeTransport = fn ?? defaultInvoke;
}

async function invokeRequestor(
  sessionId: number,
  command: RequestorCommand,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const registration = registry.get(sessionId);
  if (!registration) {
    logger.info(`requestor ${command}: no session ${sessionId} registered`);
    return false;
  }
  if (registration.session.isClosed) {
    logger.info(`requestor ${command}: session ${sessionId} already closed`);
    return false;
  }
  const request: RequestorCommandRequest = {
    endpoint: registration.requestorEndpoint,
    cluster: WebRtcTransportRequestor.Cluster,
    command,
    fields,
  };
  try {
    return await invokeTransport({ registration, request });
  } catch (err) {
    logger.info(
      `requestor ${command} failed for session ${sessionId}: ${errText(err)}`,
    );
    return false;
  }
}

// Production transport: a dedicated exchange over the controller's session, one
// ClientInteraction, closed after the single command completes.
async function defaultInvoke({
  registration,
  request,
}: RequestorInvocation): Promise<boolean> {
  const { session, env } = registration;
  const exchangeManager = env.get(ExchangeManager);
  const exchangeProvider = new DedicatedChannelExchangeProvider(
    exchangeManager,
    session,
  );
  const client = new ClientInteraction({ environment: env, exchangeProvider });
  try {
    const result = client.invoke(
      Invoke({
        commands: [
          {
            endpoint: request.endpoint,
            cluster: request.cluster,
            command: request.command,
            // biome-ignore lint/suspicious/noExplicitAny: fields typed per command by caller
            fields: request.fields as any,
          },
        ],
      }),
    );
    for await (const chunk of result) {
      for (const entry of chunk) {
        if (entry.kind === "cmd-status") {
          if (entry.status !== Status.Success) {
            logger.info(
              `requestor ${request.command} status ${entry.status} for session ${String(request.fields.webRtcSessionId)}`,
            );
            return false;
          }
          return true;
        }
      }
    }
    // No cmd-status chunk (suppressed response): treat as delivered.
    return true;
  } finally {
    await client.close().catch(() => {});
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
