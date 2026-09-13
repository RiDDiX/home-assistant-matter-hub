import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #471: matter.js logs every failed subscription update at INFO, including the
// third one that kills the subscription, so a dying controller link is
// invisible to anyone filtering for warnings. The patch keeps the first two
// retries at INFO and raises the final failure and the give-up line to WARN.

const require = createRequire(import.meta.url);

function serverSubscriptionSource(variant: "esm" | "cjs"): string {
  const entry = require.resolve("@matter/node");
  return readFileSync(
    join(entry, "..", "..", variant, "node", "server", "ServerSubscription.js"),
    "utf8",
  );
}

describe("subscription failure log levels (#471)", () => {
  it.each([
    "esm",
    "cjs",
  ] as const)("the installed @matter/node %s build escalates a dying subscription", (variant) => {
    const source = serverSubscriptionSource(variant);
    expect(source).toContain(
      'logger[this.#sendUpdateErrorCounter > 2 ? "warn" : "info"](',
    );
    expect(source).toMatch(/logger\.warn\(\s*`Giving up on subscription/);
  });
});
