import {
  type Environment,
  Logger,
  LogLevel,
  Observable,
} from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import * as trace from "./pairing-trace.js";
import { SessionSupervisor } from "./session-supervisor.js";

vi.mock("./pairing-trace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pairing-trace.js")>();
  return {
    acquirePairingTrace: vi.fn(actual.acquirePairingTrace),
    releasePairingTrace: vi.fn(actual.releasePairingTrace),
  };
});

const facility = "InteractionServer";

function fakeEnv(armed: boolean) {
  const events = { added: Observable(), deleted: Observable() };
  const env = {
    has: () => armed,
    get: () => {
      throw new Error("not available");
    },
    eventsFor: () => events,
  } as unknown as Environment;
  return { env, events };
}

function supervisor(env: Environment, lines: string[] = []) {
  const log = (...args: unknown[]) => lines.push(String(args[0]));
  return new SessionSupervisor(
    { debug() {}, info: log, warn: log, error() {} } as unknown as Logger,
    { env },
    { id: "b", featureFlags: {} } as unknown as BridgeDataProvider,
    () => ({ id: "b", name: "b" }),
    0,
  );
}

const level = () => Logger.facilityLevels[facility];

describe("SessionSupervisor pairing trace", () => {
  const started: SessionSupervisor[] = [];
  const start = (env: Environment, lines?: string[]) => {
    const sup = supervisor(env, lines);
    sup.start();
    started.push(sup);
    return sup;
  };
  afterEach(() => {
    for (const sup of started.splice(0)) sup.stop();
    vi.mocked(trace.acquirePairingTrace).mockReset();
    vi.mocked(trace.releasePairingTrace).mockReset();
    delete Logger.facilityLevels[facility];
  });

  const fail = () => {
    throw new Error("boom");
  };

  it("failsafe added and deleted drive debug on and off", () => {
    const { env, events } = fakeEnv(false);
    start(env);
    expect(level()).toBeUndefined();
    events.added.emit({});
    expect(level()).toBe(LogLevel.DEBUG);
    events.added.emit({});
    events.deleted.emit({});
    expect(level()).toBeUndefined();
  });

  it("stop while armed restores the level", () => {
    const { env, events } = fakeEnv(false);
    const sup = start(env);
    events.added.emit({});
    sup.stop();
    expect(level()).toBeUndefined();
    events.added.emit({});
    expect(level()).toBeUndefined();
  });

  it("an environment armed at start turns debug on", () => {
    start(fakeEnv(true).env);
    expect(level()).toBe(LogLevel.DEBUG);
  });

  it("debug stays on while another bridge is armed", () => {
    const a = fakeEnv(false);
    const b = fakeEnv(false);
    start(a.env);
    start(b.env);
    a.events.added.emit({});
    b.events.added.emit({});
    a.events.deleted.emit({});
    expect(level()).toBe(LogLevel.DEBUG);
    b.events.deleted.emit({});
    expect(level()).toBeUndefined();
  });

  it("a failing switch on the failsafe added event does not throw", () => {
    const { env, events } = fakeEnv(false);
    const lines: string[] = [];
    start(env, lines);
    vi.mocked(trace.acquirePairingTrace).mockImplementation(fail);
    expect(() => events.added.emit({})).not.toThrow();
    expect(lines).toContain("Pairing trace switch failed:");
  });

  it("a failing switch while armed at start does not stop start", () => {
    vi.mocked(trace.acquirePairingTrace).mockImplementation(fail);
    const lines: string[] = [];
    const sup = supervisor(fakeEnv(true).env, lines);
    expect(() => sup.start()).not.toThrow();
    expect(lines).toContain("Session rotation off (no max age set)");
    expect(() => sup.stop()).not.toThrow();
  });

  it("a failing release does not make stop throw", () => {
    const { env, events } = fakeEnv(false);
    const sup = supervisor(env);
    sup.start();
    events.added.emit({});
    vi.mocked(trace.releasePairingTrace).mockImplementation(fail);
    expect(() => sup.stop()).not.toThrow();
    vi.mocked(trace.releasePairingTrace).mockReset();
    trace.releasePairingTrace();
  });
});
