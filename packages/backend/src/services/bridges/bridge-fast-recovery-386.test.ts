import { describe, expect, it } from "vitest";
import { deadSessionTimeoutMs } from "./bridge.js";

// fastSessionRecovery (#386): the flag picks a 5s dead-session timeout, off
// keeps the 60s default so working setups are unchanged.
describe("deadSessionTimeoutMs (#386)", () => {
  it("keeps 60s by default", () => {
    expect(deadSessionTimeoutMs(undefined)).toBe(60_000);
    expect(deadSessionTimeoutMs({})).toBe(60_000);
    expect(deadSessionTimeoutMs({ fastSessionRecovery: false })).toBe(60_000);
  });

  it("drops to 5s when fastSessionRecovery is on", () => {
    expect(deadSessionTimeoutMs({ fastSessionRecovery: true })).toBe(5_000);
  });
});
