import { Logger } from "@matter/general";
import { OperationalCredentialsServer } from "@matter/main/behaviors";
import type { OperationalCredentials } from "@matter/main/clusters";

const logger = Logger.get("AttestationWarning");

// A controller that accepts the attestation follows up within milliseconds.
// Long enough that a slow one is not reported, short enough to reach the log
// while the user is still looking at the failed pairing.
export const CSR_GRACE_MS = 10_000;

const pending = new Map<string, NodeJS.Timeout>();

/** Arm the "no CSRRequest followed" watch for one commissioning attempt. */
export function watchForCsr(key: string, onMissing: () => void) {
  csrArrived(key);
  const timer = setTimeout(() => {
    pending.delete(key);
    onMissing();
  }, CSR_GRACE_MS);
  timer.unref?.();
  pending.set(key, timer);
}

/** Commissioning moved on, drop the watch. */
export function csrArrived(key: string) {
  const timer = pending.get(key);
  if (timer) {
    clearTimeout(timer);
    pending.delete(key);
  }
}

/**
 * #465: a controller that does not trust our device attestation aborts right
 * after AttestationRequest and never sends CSRRequest, which leaves the user
 * with a bare "Failed" and nothing in the log. Name the step so the failure is
 * readable. Detection only, the certificates cannot be changed from here.
 */
export class AttestationWarningServer extends OperationalCredentialsServer {
  override async attestationRequest(
    request: OperationalCredentials.AttestationRequest,
  ) {
    const response = await super.attestationRequest(request);
    watchForCsr(this.watchKey(), () =>
      logger.warn(
        `No CSRRequest arrived within ${CSR_GRACE_MS / 1000}s of the attestation step. A controller that refuses the device attestation stops exactly here, this bridge serves the matter.js development attestation (test vendor 0xFFF1, Matter Test PAA, certification type "test") and controllers that only pair with CSA certified products reject it. A cancelled pairing looks the same in the log (#465)`,
      ),
    );
    return response;
  }

  override async csrRequest(request: OperationalCredentials.CsrRequest) {
    csrArrived(this.watchKey());
    return super.csrRequest(request);
  }

  // One watch per commissioning attempt, not per bridge: two controllers can
  // sit in the failsafe at once and would otherwise share a timer.
  private watchKey(): string {
    const session =
      "session" in this.context ? this.context.session?.id : undefined;
    return `${this.endpoint.id}:${session ?? "local"}`;
  }
}
