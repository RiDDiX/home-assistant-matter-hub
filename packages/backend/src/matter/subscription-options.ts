import { Seconds } from "@matter/general";

// Shared Matter subscription window for every HAMH node, the aggregator bridge
// and server mode alike. No jitter: matter.js adds up to 10s over the
// controller's max interval, pushing our keepalive past Google's ceiling so it
// drops the sub (#386). The 60s max keeps keepalives frequent enough that iOS
// does not show a stale "Updating" tile (#287). Kept in one place so the two
// node types cannot drift apart again. Fresh object per call, matter.js keeps
// a reference.
export function matterSubscriptionOptions() {
  return {
    minInterval: Seconds(2),
    maxInterval: Seconds(60),
    randomizationWindow: Seconds(0),
  };
}
