import { describe, expect, it } from "vitest";
import { VacuumReadiness } from "./vacuum-readiness.js";

const snap = (state: string, time: number) => ({
  state,
  last_changed: new Date(time).toISOString(),
});

describe("vacuum readiness settling", () => {
  it("keeps map processing busy through the Ready blip and releases stable Ready", () => {
    const r = new VacuumReadiness();
    expect(r.read("docked", snap("saving_map", 0), 0).kind).toBe(
      "updating_maps",
    );
    expect(r.read("docked", snap("ready", 40_000), 40_999).kind).toBe(
      "updating_maps",
    );
    expect(r.read("docked", snap("downloading_map", 41_000), 41_000).kind).toBe(
      "updating_maps",
    );
    expect(r.read("docked", snap("ready", 55_000), 59_999).kind).toBe(
      "updating_maps",
    );
    expect(r.read("docked", snap("ready", 55_000), 60_000).kind).toBe("ready");
  });

  it("provides a settling deadline even without another HA event", () => {
    const r = new VacuumReadiness();
    r.read("idle", snap("downloading_map", 0), 0);
    expect(r.read("idle", snap("ready", 1000), 2000).recheckAfterMs).toBe(4000);
    expect(
      r.read("idle", snap("ready", 1000), 6000).recheckAfterMs,
    ).toBeUndefined();
  });

  it("settles from first observation when the timestamp is missing or future-dated", () => {
    const r = new VacuumReadiness();
    expect(r.read("docked", { state: "ready" }, 1000).kind).toBe("blocked");
    expect(r.read("docked", { state: "ready" }, 6000).kind).toBe("ready");
    const future = new VacuumReadiness();
    expect(
      future.read("docked", snap("ready", 20_000), 1000).recheckAfterMs,
    ).toBe(5000);
    expect(future.read("docked", snap("ready", 20_000), 6000).kind).toBe(
      "ready",
    );
  });

  it("restarts settling when a newer Ready follows an unobserved state change", () => {
    const r = new VacuumReadiness();
    expect(r.read("docked", snap("ready", 0), 10_000).kind).toBe("ready");
    expect(r.read("docked", snap("ready", 20_000), 20_000).kind).toBe(
      "blocked",
    );
    expect(r.read("docked", snap("ready", 20_000), 25_000).kind).toBe("ready");
  });

  it("settles Roomba+ Prime's none like ready", () => {
    const r = new VacuumReadiness();
    r.read("docked", snap("saving_map", 0), 0);
    expect(r.read("docked", snap("none", 1000), 3000).kind).toBe(
      "updating_maps",
    );
    expect(r.read("docked", snap("none", 1000), 6000).kind).toBe("ready");
    const untimed = new VacuumReadiness();
    expect(untimed.read("docked", { state: "none" }, 1000).kind).toBe(
      "blocked",
    );
    expect(untimed.read("docked", { state: "none" }, 6000).kind).toBe("ready");
  });

  it.each([
    "cleaning",
    "returning",
    "paused",
    "error",
    "unavailable",
  ])("preserves actual %s status despite a stale readiness refusal", (state) => {
    expect(
      new VacuumReadiness().read(state, snap("bin_full", 0), 100).kind,
    ).toBe("pass_through");
  });

  it.each([
    "unknown",
    "unavailable",
    "not_ready_999",
    "bin_full",
  ])("does not report Ready for %s", (state) => {
    expect(new VacuumReadiness().read("docked", { state }, 100).kind).toBe(
      "blocked",
    );
  });

  it("fails closed when the mapped sensor is missing", () => {
    expect(new VacuumReadiness().read("docked", undefined, 100).kind).toBe(
      "blocked",
    );
  });
});
