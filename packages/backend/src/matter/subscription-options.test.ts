import { Seconds } from "@matter/general";
import { describe, expect, it } from "vitest";
import { matterSubscriptionOptions } from "./subscription-options.js";

// #386: every HAMH node (aggregator bridge and server mode) must use the same
// zero-jitter window, else matter.js adds up to 10s and the keepalive lands
// past Google's ceiling so it drops the sub. Server mode used to carry a 10s
// jitter of its own, this locks both paths to one source.
describe("matterSubscriptionOptions (#386)", () => {
  it("has no randomization jitter", () => {
    expect(matterSubscriptionOptions().randomizationWindow).toEqual(Seconds(0));
  });

  it("keeps the 60s max and 2s min interval", () => {
    const opts = matterSubscriptionOptions();
    expect(opts.maxInterval).toEqual(Seconds(60));
    expect(opts.minInterval).toEqual(Seconds(2));
  });

  it("returns a fresh object each call", () => {
    expect(matterSubscriptionOptions()).not.toBe(matterSubscriptionOptions());
  });
});
