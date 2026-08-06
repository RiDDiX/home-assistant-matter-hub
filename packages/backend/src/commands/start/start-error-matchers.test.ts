import { describe, expect, it } from "vitest";
import {
  isIsolatableError,
  shouldSuppressError,
} from "./start-error-matchers.js";

const BRIDGE_ID = "ed5b4f8d042e4599b833f21da4ededba";

// #435: a part that throws while the aggregator itself is still being built
// surfaces as "Error initializing part <bridgeId>.aggregator", with no trailing
// dot and no cluster segment. That message reached process.exit(1).
const AGGREGATOR_INIT = `Error initializing part ${BRIDGE_ID}.aggregator`;

// Fatals outside the aggregator subtree. Swallowing any of these leaves the
// process running as a zombie instead of exiting for a supervisor restart.
const ROOT_FATALS = [
  `Error in reactor<${BRIDGE_ID}.commissioning.reactCommissioned>: FATAL disk failure`,
  `Error in reactor<${BRIDGE_ID}.network.online>: EADDRINUSE :::5540`,
  `Error initializing part ${BRIDGE_ID}.parts.somethingElse: EACCES`,
  "Cannot read properties of undefined (reading 'aggregator')",
  "Entity sensor.solar_aggregator_power is invalid: FATAL",
  "EADDRINUSE",
];

describe("shouldSuppressError", () => {
  it("suppresses an aggregator construction failure", () => {
    expect(shouldSuppressError(new Error(AGGREGATOR_INIT))).toBe(true);
  });

  it("suppresses a reactor failure", () => {
    expect(
      shouldSuppressError(
        new Error(`Error in reactor<${BRIDGE_ID}.aggregator.Lamp.onOff>`),
      ),
    ).toBe(true);
  });

  it("keeps suppressing the messages it already matched", () => {
    for (const msg of [
      "Connection lost",
      "Endpoint storage inaccessible",
      "Invalid intervalMs",
      "generalDiagnostics",
      "Behaviors have errors",
      "TransactionDestroyedError",
      "DestroyedDependencyError",
      "UninitializedDependencyError",
      "mutex-closed",
      "not a node and is not owned",
      `${BRIDGE_ID}.aggregator.Lamp.onOff.on`,
    ]) {
      expect(shouldSuppressError(new Error(msg)), msg).toBe(true);
    }
  });

  it("still crashes on an unrelated error", () => {
    expect(shouldSuppressError(new Error("out of memory"))).toBe(false);
  });

  it("still crashes on root node fatals outside the aggregator subtree", () => {
    for (const msg of ROOT_FATALS) {
      expect(shouldSuppressError(new Error(msg)), msg).toBe(false);
    }
  });
});

describe("isIsolatableError", () => {
  it("isolates an aggregator construction failure", () => {
    expect(isIsolatableError(new Error(AGGREGATOR_INIT))).toBe(true);
  });

  it("isolates a reactor failure", () => {
    expect(
      isIsolatableError(
        new Error(`Error in reactor<${BRIDGE_ID}.aggregator.Lamp.onOff>`),
      ),
    ).toBe(true);
  });

  it("keeps isolating the messages it already matched", () => {
    for (const msg of [
      "Invalid intervalMs",
      "Behaviors have errors",
      "TransactionDestroyedError",
      "DestroyedDependencyError",
      "UninitializedDependencyError",
      "Endpoint storage inaccessible",
      `${BRIDGE_ID}.aggregator.Lamp.onOff.on`,
    ]) {
      expect(isIsolatableError(new Error(msg)), msg).toBe(true);
    }
  });

  it("leaves an unrelated error alone", () => {
    expect(isIsolatableError(new Error("out of memory"))).toBe(false);
  });

  it("leaves root node fatals outside the aggregator subtree alone", () => {
    for (const msg of ROOT_FATALS) {
      expect(isIsolatableError(new Error(msg)), msg).toBe(false);
    }
  });
});

// start-handler.ts registers process-wide uncaughtException handlers at import
// time, which would swallow real crashes inside this vitest worker. The
// matchers live in their own module so this file never pulls that in.
describe("start-error-matchers module", () => {
  it("registers no process listeners on import", async () => {
    const before = process.listenerCount("uncaughtException");
    await import("./start-error-matchers.js");
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });
});
