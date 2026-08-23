import type { Environment, Logger } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { DEFAULT_SESSION_MAX_AGE_HOURS } from "./session-rotation.js";
import { SessionSupervisor } from "./session-supervisor.js";

// The two bridges deliberately differ in one place: with no configured max
// age, the aggregator bridge keeps rotation off (one controller session
// holds many devices) while server mode rotates after the default hours.
// The supervisor takes that as a parameter, pin both sides.

function supervisor(defaultHours: number, sessionMaxAgeHours?: number) {
  const warn = vi.fn();
  const sup = new SessionSupervisor(
    { debug() {}, info() {}, warn, error() {} } as unknown as Logger,
    { env: {} as Environment },
    {
      id: "b",
      featureFlags: {},
      sessionMaxAgeHours,
    } as unknown as BridgeDataProvider,
    () => ({ id: "b", name: "b" }),
    defaultHours,
  );
  const read = () =>
    (
      sup as unknown as { readSessionMaxAgeHours(): number }
    ).readSessionMaxAgeHours();
  return { read, warn };
}

describe("SessionSupervisor rotation default", () => {
  afterEach(() => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
  });

  it("aggregator bridge: unset env keeps rotation off", () => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
    expect(supervisor(0).read()).toBe(0);
  });

  it("server mode: unset env falls back to the default hours", () => {
    delete process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS;
    expect(supervisor(DEFAULT_SESSION_MAX_AGE_HOURS).read()).toBe(
      DEFAULT_SESSION_MAX_AGE_HOURS,
    );
  });

  it("garbage env warns and uses the side default", () => {
    process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS = "nope";
    const off = supervisor(0);
    expect(off.read()).toBe(0);
    expect(off.warn.mock.calls[0][0]).toContain("disabling session rotation");
    const on = supervisor(DEFAULT_SESSION_MAX_AGE_HOURS);
    expect(on.read()).toBe(DEFAULT_SESSION_MAX_AGE_HOURS);
    expect(on.warn.mock.calls[0][0]).toContain(
      `falling back to ${DEFAULT_SESSION_MAX_AGE_HOURS}h`,
    );
  });

  it("a configured value wins on both sides", () => {
    process.env.HAMH_MATTER_SESSION_MAX_AGE_HOURS = "nope";
    expect(supervisor(0, 12).read()).toBe(12);
    expect(supervisor(DEFAULT_SESSION_MAX_AGE_HOURS, 0).read()).toBe(0);
  });
});
