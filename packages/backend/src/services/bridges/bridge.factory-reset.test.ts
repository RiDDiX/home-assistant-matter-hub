import { BridgeStatus } from "@home-assistant-matter-hub/common";
import { describe, expect, it, vi } from "vitest";
import { Bridge } from "./bridge.js";
import type { BridgeServerStatus } from "./bridge-data-provider.js";
import { ServerModeBridge } from "./server-mode-bridge.js";

// A factory reset used to skip the stop path, so the restart rejected every
// plugin as already registered (#477, #478). Prototype fakes as in
// bridge.im-tracking.test.ts, the real constructors build a live ServerNode.

function makeCollaborators(calls: string[]) {
  const track =
    (name: string) =>
    async (...__: unknown[]) => {
      calls.push(name);
    };
  return {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    sessions: {
      stop: () => calls.push("sessions.stop"),
      start: () => calls.push("sessions.start"),
      closeActiveSessions: track("closeActiveSessions"),
    },
    endpointManager: {
      stopPlugins: track("stopPlugins"),
      stopObserving: () => calls.push("stopObserving"),
    },
    server: {
      cancel: track("server.cancel"),
      factoryReset: track("server.factoryReset"),
    },
    dataProvider: { id: "b", name: "b" },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the fields under test are private
function prepare(bridge: any, calls: string[]) {
  Object.assign(bridge, makeCollaborators(calls), {
    status: { code: BridgeStatus.Running },
    autoForceSyncTimer: null,
    warmStartTimer: null,
  });
  const seen: BridgeServerStatus[] = [];
  bridge.start = vi.fn(async () => {
    calls.push("start");
    seen.push({ ...bridge.status });
    bridge.status = { code: BridgeStatus.Running };
  });
  return { statusAtStart: seen };
}

describe.each([
  ["Bridge", Bridge],
  ["ServerModeBridge", ServerModeBridge],
])("%s factory reset", (_name, Ctor) => {
  it("stops before erasing and restarting", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Ctor.prototype);
    prepare(bridge, calls);

    await bridge.factoryReset();

    expect(calls).toContain("server.cancel");
    expect(calls.indexOf("server.cancel")).toBeLessThan(
      calls.indexOf("server.factoryReset"),
    );
    expect(calls.indexOf("server.factoryReset")).toBeLessThan(
      calls.indexOf("start"),
    );
  });

  it("stops with the factory reset reason", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Ctor.prototype);
    const { statusAtStart } = prepare(bridge, calls);

    await bridge.factoryReset();

    expect(statusAtStart[0]).toEqual({
      code: BridgeStatus.Stopped,
      reason: "Factory reset",
    });
  });

  it("ignores a bridge that is not running", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Ctor.prototype);
    prepare(bridge, calls);
    bridge.status = { code: BridgeStatus.Stopped };

    await bridge.factoryReset();

    expect(calls).toEqual([]);
  });
});

describe.each([
  ["Bridge", Bridge],
  ["ServerModeBridge", ServerModeBridge],
])("%s factory reset in flight", (_name, Ctor) => {
  it("shares one run between two overlapping requests", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Ctor.prototype);
    prepare(bridge, calls);

    await Promise.all([bridge.factoryReset(), bridge.factoryReset()]);

    expect(calls.filter((c) => c === "server.factoryReset")).toHaveLength(1);
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
  });

  it("joins a request that arrives while the bridge is stopped mid reset", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Ctor.prototype);
    prepare(bridge, calls);
    let second: Promise<void> | undefined;
    bridge.server.factoryReset = async () => {
      calls.push("server.factoryReset");
      expect(bridge.status.code).toBe(BridgeStatus.Stopped);
      second = bridge.factoryReset();
    };

    await bridge.factoryReset();
    await second;

    expect(calls.filter((c) => c === "server.factoryReset")).toHaveLength(1);
    expect(calls.filter((c) => c === "start")).toHaveLength(1);
  });
});

describe("Bridge factory reset plugins", () => {
  it("shuts the plugins down so the restart can register them again", async () => {
    const calls: string[] = [];
    const bridge = Object.create(Bridge.prototype);
    prepare(bridge, calls);

    await bridge.factoryReset();

    expect(calls).toContain("stopPlugins");
    expect(calls.indexOf("stopPlugins")).toBeLessThan(calls.indexOf("start"));
  });
});
