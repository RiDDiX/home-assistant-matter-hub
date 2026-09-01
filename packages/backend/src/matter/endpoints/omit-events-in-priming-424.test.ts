import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #424: the Google workaround lives in two halves. The patched matter.js
// ServerSubscription skips the event section of the priming report when the
// node carries hamhOmitEventsInPriming, and the HAMH node classes set that
// field from the bridge feature flag. Each half is useless without the other,
// so pin both: a matter.js bump that drops the patch, or a rename of either
// side, must fail here instead of silently turning the flag into a no-op.

const require = createRequire(import.meta.url);

function serverSubscriptionSource(variant: "esm" | "cjs"): string {
  // resolves to dist/cjs/index.js, ServerSubscription lives two levels up
  const entry = require.resolve("@matter/node");
  return readFileSync(
    join(entry, "..", "..", variant, "node", "server", "ServerSubscription.js"),
    "utf8",
  );
}

describe("omit events in priming (#424)", () => {
  it.each([
    "esm",
    "cjs",
  ] as const)("the installed @matter/node %s build carries the priming guard", (variant) => {
    const source = serverSubscriptionSource(variant);
    expect(source).toContain(
      "this.#context.node.hamhOmitEventsInPriming === true",
    );
    // the guard must not fire for an events-only subscription, or the
    // priming would throw InvalidAction for having nothing to report
    expect(source).toContain("validAttributes > 0 &&");
  });

  it("the flag lands on the node classes as hamhOmitEventsInPriming", async () => {
    const { BridgeServerNode } = await import("./bridge-server-node.js");
    const { ServerModeServerNode } = await import(
      "./server-mode-server-node.js"
    );
    // pin the property name the patch reads, without booting a ServerNode
    const bridgeSource = BridgeServerNode.toString();
    const serverModeSource = ServerModeServerNode.toString();
    for (const source of [bridgeSource, serverModeSource]) {
      expect(source).toContain("hamhOmitEventsInPriming");
      expect(source).toContain("omitEventsInPriming");
    }
  });
});
