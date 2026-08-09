import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@matter/general";
import type { Connection } from "home-assistant-js-websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FilePluginStorage,
  pluginStorageFilePath,
} from "../../plugin-storage.js";
import type {
  PluginContext,
  PluginDevice,
  PluginStorage,
} from "../../types.js";
import { SecurityPlugin } from "./security-plugin.js";

function makeStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    keys: vi.fn(async () => [...data.keys()]),
  };
}

function createMockContext(overrides: Partial<PluginContext> = {}) {
  const devices = new Map<string, PluginDevice>();
  const ctx = {
    bridgeId: "b",
    log: Logger.get("test"),
    storage: makeStorage() as unknown as PluginStorage,
    registerDevice: vi.fn(async (device: PluginDevice) => {
      devices.set(device.id, device);
    }),
    unregisterDevice: vi.fn(async (id: string) => {
      devices.delete(id);
    }),
    updateDeviceState: vi.fn(),
    registerDomainMapping: vi.fn(),
    ...overrides,
  };
  return { ctx: ctx as PluginContext, devices };
}

interface ServiceMessage {
  type?: string;
  domain?: string;
  service?: string;
  target?: { entity_id?: string };
}

function fakeConnection() {
  return {
    connected: true,
    sendMessagePromise: vi.fn(async (_msg: ServiceMessage) => ({})),
    subscribeEvents: vi.fn(async () => () => {}),
    addEventListener: vi.fn(),
    close: vi.fn(),
  };
}

const ha = { url: "http://ha:8123", accessToken: "tok" };

async function armVia(devices: Map<string, PluginDevice>, id: string) {
  await devices.get(id)?.onAttributeWrite?.("onOff", "onOff", true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SecurityPlugin", () => {
  it("registers the four mode switches and the alarm sensor", async () => {
    const { ctx } = createMockContext();
    const plugin = new SecurityPlugin({ homeTriggers: "binary_sensor.door" });
    await plugin.onStart(ctx);

    expect(ctx.registerDevice).toHaveBeenCalledTimes(5);
    const calls = vi.mocked(ctx.registerDevice).mock.calls.map(([d]) => ({
      id: d.id,
      name: d.name,
      deviceType: d.deviceType,
    }));
    expect(calls).toEqual([
      { id: "mode_home", name: "Home", deviceType: "on_off_plugin_unit" },
      { id: "mode_away", name: "Away", deviceType: "on_off_plugin_unit" },
      { id: "mode_night", name: "Night", deviceType: "on_off_plugin_unit" },
      {
        id: "mode_vacation",
        name: "Vacation",
        deviceType: "on_off_plugin_unit",
      },
      { id: "alarm", name: "Alarm", deviceType: "contact_sensor" },
    ]);
    await plugin.onShutdown();
  });

  it("registers nothing while no trigger list is configured (#439)", async () => {
    const { ctx } = createMockContext();
    const plugin = new SecurityPlugin();
    await plugin.onStart(ctx);

    expect(ctx.registerDevice).not.toHaveBeenCalled();
    await plugin.onShutdown();
  });

  it("mounts the devices live when a config change adds a trigger (#439)", async () => {
    const { ctx, devices } = createMockContext();
    const plugin = new SecurityPlugin();
    await plugin.onStart(ctx);
    expect(ctx.registerDevice).not.toHaveBeenCalled();

    await plugin.onConfigChanged({
      exitDelaySeconds: 0,
      entryDelaySeconds: 0,
      homeTriggers: "binary_sensor.door",
    });
    expect(devices.size).toBe(5);

    // The freshly mounted switches drive the machine.
    await armVia(devices, "mode_home");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "door");
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      { stateValue: false },
    );
    await plugin.onShutdown();
  });

  it("removes the devices when a config change empties the triggers (#439)", async () => {
    const { ctx, devices } = createMockContext();
    const plugin = new SecurityPlugin({
      exitDelaySeconds: 0,
      homeTriggers: "binary_sensor.door",
    });
    await plugin.onStart(ctx);
    expect(devices.size).toBe(5);

    await plugin.onConfigChanged({ exitDelaySeconds: 0 });
    expect(devices.size).toBe(0);
    await plugin.onShutdown();
  });

  it("exposes the full config schema with a secret token", () => {
    const schema = new SecurityPlugin().getConfigSchema();
    expect(Object.keys(schema.properties)).toEqual([
      "exitDelaySeconds",
      "entryDelaySeconds",
      "triggerTimeSeconds",
      "homeSetters",
      "homeTriggers",
      "homeAlerts",
      "awaySetters",
      "awayTriggers",
      "awayAlerts",
      "nightSetters",
      "nightTriggers",
      "nightAlerts",
      "vacationSetters",
      "vacationTriggers",
      "vacationAlerts",
      "offSetters",
      "triggers24h",
      "alerts24h",
      "alwaysAlerts",
      "haUrl",
      "haToken",
    ]);
    expect(schema.properties.haToken.secret).toBe(true);
    expect(schema.properties.exitDelaySeconds).toMatchObject({
      type: "number",
      default: 60,
    });
    expect(schema.properties.entryDelaySeconds.default).toBe(60);
    expect(schema.properties.triggerTimeSeconds.default).toBe(120);
    expect(schema.properties.alwaysAlerts.title).toBe("Always");
    // The fallback is a documented behavior, the field description must say it.
    expect(schema.properties.vacationSetters.description).toMatch(/away/i);
    expect(schema.properties.vacationTriggers.description).toMatch(/away/i);
    expect(schema.properties.vacationAlerts.description).toMatch(/away/i);
  });

  it("merges persisted config over the seed and reports it", async () => {
    const storage = makeStorage({
      config: { awayTriggers: "binary_sensor.x", exitDelaySeconds: 5 },
    });
    const { ctx } = createMockContext({
      storage: storage as unknown as PluginStorage,
    });
    const plugin = new SecurityPlugin({ exitDelaySeconds: 99 });
    await plugin.onStart(ctx);

    expect(plugin.getCurrentConfig()).toMatchObject({
      awayTriggers: "binary_sensor.x",
      exitDelaySeconds: 5,
    });
    await plugin.onShutdown();
  });

  it("dispatches mode setters per domain on reaching armed", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.arm_home,script.notify,switch.led",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_home");

    await vi.waitFor(() => {
      const calls = conn.sendMessagePromise.mock.calls.map(([m]) => m);
      const services = calls.filter((m) => m.type === "call_service");
      expect(services).toHaveLength(3);
      expect(services).toEqual([
        expect.objectContaining({ domain: "scene", service: "turn_on" }),
        expect.objectContaining({ domain: "script", service: "turn_on" }),
        expect.objectContaining({ domain: "switch", service: "turn_on" }),
      ]);
    });
    await plugin.onShutdown();
  });

  it("uses the away triggers and alerts for vacation when left empty", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.horn",
        vacationTriggers: "",
        vacationAlerts: "",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_vacation");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "door");

    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: false,
      },
    );
    await vi.waitFor(() => {
      expect(conn.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "siren", service: "turn_on" }),
      );
    });
    await plugin.onShutdown();
  });

  it("fires tier alerts union always on trip and silences them on leaving triggered", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        triggerTimeSeconds: 0,
        triggers24h: "binary_sensor.smoke",
        alerts24h: "siren.a,script.b",
        alwaysAlerts: "light.c,siren.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    plugin.handleTriggerEvent("binary_sensor.smoke", "on", "smoke");

    await vi.waitFor(() => {
      const on = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on");
      expect(on.map((m) => m.target?.entity_id)).toEqual([
        "siren.a",
        "script.b",
        "light.c",
      ]);
    });

    // Arming out of triggered leaves the alarm: sirens and lights get an off
    // call, the script does not, and the contact sensor closes.
    await armVia(devices, "mode_home");
    await vi.waitFor(() => {
      const off = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id)).toEqual([
        "siren.a",
        "light.c",
      ]);
    });
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: true,
      },
    );
    await plugin.onShutdown();
  });

  it("fires the 24h alerts during a burglar trip and silences both sets on disarm", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.burglar",
        triggers24h: "binary_sensor.smoke",
        alerts24h: "siren.smoke",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_away");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "door");
    await vi.waitFor(() => {
      const on = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on");
      expect(on.map((m) => m.target?.entity_id)).toEqual(["siren.burglar"]);
    });

    // Smoke while the burglar alarm is already blaring.
    plugin.handleTriggerEvent("binary_sensor.smoke", "on", "smoke");
    await vi.waitFor(() => {
      const on = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on");
      expect(on.map((m) => m.target?.entity_id)).toEqual([
        "siren.burglar",
        "siren.smoke",
      ]);
    });

    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.waitFor(() => {
      const off = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id).sort()).toEqual([
        "siren.burglar",
        "siren.smoke",
      ]);
    });
    await plugin.onShutdown();
  });

  it("uses the bridge credentials when only haUrl is set", async () => {
    const conn = fakeConnection();
    const connect = vi.fn(async () => conn as unknown as Connection);
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { haUrl: "http://elsewhere:8123", homeTriggers: "binary_sensor.motion" },
      { connect },
    );
    const warn = vi.fn();
    Object.assign(plugin as unknown as { log: object }, {
      log: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
    });
    await plugin.onStart(ctx);
    // haUrl without a token must never dial elsewhere with the bridge token.
    expect(connect).toHaveBeenCalledWith("http://ha:8123", "tok");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(
      /haUrl.*haToken|haToken.*haUrl/,
    );
    await plugin.onShutdown();
  });

  it("silences pre-restart alerts at start when a finite trigger time resolves out of triggered", async () => {
    const storage = makeStorage({
      state: { mode: "away", phase: "triggered" },
    });
    const conn = fakeConnection();
    const { ctx } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      {
        triggerTimeSeconds: 120,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.horn",
        homeAlerts: "script.wake",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    // The restore resolved to armed, so disarm never comes: the pre-restart
    // siren has to be silenced right at start.
    await vi.waitFor(() => {
      const off = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id)).toEqual(["siren.horn"]);
    });
    expect(storage.data.get("state")).toMatchObject({
      mode: "away",
      phase: "armed",
    });
    await plugin.onShutdown();
  });

  it("keeps a chasing disarm behind the trip batch so no turn_on lands after its turn_off", async () => {
    const conn = fakeConnection();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: ServiceMessage[] = [];
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      seen.push(msg);
      if (msg.service === "turn_on" && msg.target?.entity_id === "siren.a") {
        await gate;
      }
      return {};
    });
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.a,siren.b,siren.c",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_away");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
    await vi.waitFor(() =>
      expect(seen.some((m) => m.service === "turn_on")).toBe(true),
    );
    // Disarm while the trip batch hangs on its first siren.
    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    release();
    await vi.waitFor(() => {
      expect(seen.filter((m) => m.service === "turn_off")).toHaveLength(3);
    });
    for (const entity of ["siren.a", "siren.b", "siren.c"]) {
      const services = seen
        .filter((m) => m.target?.entity_id === entity)
        .map((m) => m.service);
      expect(services.indexOf("turn_off")).toBeGreaterThan(
        services.lastIndexOf("turn_on"),
      );
    }
    await plugin.onShutdown();
  });

  it("retries a silence that hit a connection gap once the socket is back", async () => {
    const conn = fakeConnection();
    let down = false;
    const listeners: Record<string, () => void> = {};
    conn.addEventListener = vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    });
    const seen: ServiceMessage[] = [];
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      if (down) throw new Error("socket gone");
      seen.push(msg);
      return {};
    });
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_away");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
    await vi.waitFor(() =>
      expect(seen.some((m) => m.service === "turn_on")).toBe(true),
    );
    down = true;
    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    // The turn_off attempt fails against the dead socket.
    await vi.waitFor(() =>
      expect(conn.sendMessagePromise.mock.calls.length).toBeGreaterThan(1),
    );
    down = false;
    listeners.ready?.();
    await vi.waitFor(() => {
      const off = seen.filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id)).toEqual(["siren.a"]);
    });
    await plugin.onShutdown();
  });

  it("holds mode setters through a connection gap and dispatches them on reconnect", async () => {
    const conn = fakeConnection();
    let resolveDial!: (c: Connection) => void;
    const connect = vi.fn(
      () =>
        new Promise<Connection>((r) => {
          resolveDial = r;
        }),
    );
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.arm_home",
      },
      { connect },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_home");
    expect(conn.sendMessagePromise).not.toHaveBeenCalled();
    resolveDial(conn as unknown as Connection);
    await vi.waitFor(() => {
      expect(conn.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "scene",
          service: "turn_on",
          target: { entity_id: "scene.arm_home" },
        }),
      );
    });
    await plugin.onShutdown();
  });

  it("drops held setters when the mode changed before the reconnect", async () => {
    const conn = fakeConnection();
    let resolveDial!: (c: Connection) => void;
    const connect = vi.fn(
      () =>
        new Promise<Connection>((r) => {
          resolveDial = r;
        }),
    );
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.arm_home",
      },
      { connect },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_home");
    await devices.get("mode_home")?.onAttributeWrite?.("onOff", "onOff", false);
    resolveDial(conn as unknown as Connection);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    const on = conn.sendMessagePromise.mock.calls
      .map(([m]) => m)
      .filter((m) => m.service === "turn_on");
    expect(on).toEqual([]);
    await plugin.onShutdown();
  });

  it("runs the away setters when vacation setters are empty", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        awayTriggers: "binary_sensor.door",
        awaySetters: "scene.away_on",
        vacationSetters: "",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_vacation");
    await vi.waitFor(() => {
      expect(conn.sendMessagePromise).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "scene",
          service: "turn_on",
          target: { entity_id: "scene.away_on" },
        }),
      );
    });
    await plugin.onShutdown();
  });

  it("runs a duplicated setter once", async () => {
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "script.a,script.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_home");
    await vi.waitFor(() => {
      const on = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on");
      expect(on).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(
      conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on"),
    ).toHaveLength(1);
    await plugin.onShutdown();
  });

  it("closes the socket when the event subscribe fails before retrying", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    conn.subscribeEvents = vi.fn(async () => {
      throw new Error("nope");
    });
    const connect = vi.fn(async () => conn as unknown as Connection);
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { homeTriggers: "binary_sensor.motion" },
      { connect },
    );
    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    // The half-open socket is closed before the retry timer even schedules
    // a second dial.
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    await plugin.onShutdown();
  });

  it("awaits the unsubscribe before closing the socket", async () => {
    const order: string[] = [];
    const conn = fakeConnection();
    conn.subscribeEvents = vi.fn(
      async () => () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            order.push("unsubscribed");
            resolve();
          });
        }),
    );
    conn.close = vi.fn(() => {
      order.push("closed");
    });
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { homeTriggers: "binary_sensor.motion" },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await plugin.onShutdown();
    expect(order).toEqual(["unsubscribed", "closed"]);
  });

  it("runs the mode setters after a restore from an interrupted exit delay", async () => {
    const storage = makeStorage({
      state: { mode: "night", phase: "arming" },
    });
    const conn = fakeConnection();
    const { ctx } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      { nightTriggers: "binary_sensor.motion", nightSetters: "scene.night" },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => {
      const on = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on");
      expect(on.map((m) => m.target?.entity_id)).toEqual(["scene.night"]);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(
      conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_on"),
    ).toHaveLength(1);
    expect(storage.data.get("state")).toMatchObject({
      mode: "night",
      phase: "armed",
    });
    await plugin.onShutdown();
  });

  it("silences pre-restart alerts after a restore into triggered", async () => {
    const storage = makeStorage({
      state: { mode: "away", phase: "triggered" },
    });
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.away_horn",
        homeAlerts: "script.wake",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());

    // The pre-restart trip started siren.away_horn; the first clear after the
    // restart has to turn it off even though the trip is not in memory.
    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.waitFor(() => {
      const off = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id)).toEqual(["siren.away_horn"]);
    });
    await plugin.onShutdown();
  });

  it("closes a stale dial resolved after a config change", async () => {
    const conn1 = fakeConnection();
    const conn2 = fakeConnection();
    let resolveFirst!: (c: Connection) => void;
    const connect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Connection>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(conn2 as unknown as Connection);
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { homeTriggers: "binary_sensor.motion" },
      { connect },
    );
    await plugin.onStart(ctx);

    await plugin.onConfigChanged({
      haUrl: "http://other:8123",
      haToken: "t2",
      homeTriggers: "binary_sensor.motion",
    });
    await vi.waitFor(() => expect(conn2.subscribeEvents).toHaveBeenCalled());

    // The old dial comes back only now, with the old credentials.
    resolveFirst(conn1 as unknown as Connection);
    await vi.waitFor(() => expect(conn1.close).toHaveBeenCalled());
    expect(conn1.subscribeEvents).not.toHaveBeenCalled();
    expect(conn2.close).not.toHaveBeenCalled();
    await plugin.onShutdown();
  });

  it("drops the retry of a stale dial target after a config change", async () => {
    vi.useFakeTimers();
    const conn2 = fakeConnection();
    let rejectFirst!: (e: Error) => void;
    const connect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Connection>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue(conn2 as unknown as Connection);
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { homeTriggers: "binary_sensor.motion" },
      { connect },
    );
    await plugin.onStart(ctx);

    await plugin.onConfigChanged({
      haUrl: "http://other:8123",
      haToken: "t2",
      homeTriggers: "binary_sensor.motion",
    });
    expect(connect).toHaveBeenCalledTimes(2);

    // The old dial fails after the config change: no retry of the old target.
    rejectFirst(new Error("down"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await plugin.onShutdown();
  });

  it("round-trips the arm state through storage", async () => {
    const storage = makeStorage();
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
    });
    const plugin = new SecurityPlugin({
      exitDelaySeconds: 0,
      nightTriggers: "binary_sensor.motion",
    });
    await plugin.onStart(ctx);
    await armVia(devices, "mode_night");
    expect(storage.data.get("state")).toMatchObject({
      mode: "night",
      phase: "armed",
    });
    await plugin.onShutdown();

    // A fresh instance on the same storage comes back armed.
    const { ctx: ctx2 } = createMockContext({
      storage: storage as unknown as PluginStorage,
    });
    const plugin2 = new SecurityPlugin({
      exitDelaySeconds: 0,
      nightTriggers: "binary_sensor.motion",
    });
    await plugin2.onStart(ctx2);
    expect(ctx2.updateDeviceState).toHaveBeenCalledWith("mode_night", "onOff", {
      onOff: true,
    });
    expect(ctx2.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: true,
      },
    );
    await plugin2.onShutdown();
  });

  it("resolves a restart mid-pending to armed", async () => {
    const storage = makeStorage({ state: { mode: "away", phase: "pending" } });
    const { ctx } = createMockContext({
      storage: storage as unknown as PluginStorage,
    });
    const plugin = new SecurityPlugin({ awayTriggers: "binary_sensor.door" });
    await plugin.onStart(ctx);
    // The resolution is persisted so a second restart replays nothing.
    expect(storage.data.get("state")).toMatchObject({
      mode: "away",
      phase: "armed",
    });
    expect(ctx.updateDeviceState).toHaveBeenCalledWith("mode_away", "onOff", {
      onOff: true,
    });
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: true,
      },
    );
    await plugin.onShutdown();
  });

  it("works without any HA connection", async () => {
    const { ctx, devices } = createMockContext();
    const plugin = new SecurityPlugin({
      exitDelaySeconds: 0,
      triggers24h: "binary_sensor.smoke",
    });
    await plugin.onStart(ctx);
    await armVia(devices, "mode_home");
    plugin.handleTriggerEvent("binary_sensor.smoke", "on", "smoke");
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: false,
      },
    );
    await plugin.onShutdown();
  });

  it("retries a failed HA dial with backoff", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(conn as unknown as Connection);
    const { ctx } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      { homeTriggers: "binary_sensor.motion" },
      { connect },
    );
    await plugin.onStart(ctx);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.subscribeEvents).toHaveBeenCalledWith(
      expect.any(Function),
      "state_changed",
    );
    await plugin.onShutdown();
  });

  it("writes the recovery intent to disk before the first turn_on of a trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hamh-security-flush-"));
    const storage = new FilePluginStorage(dir, "b", "security");
    const file = pluginStorageFilePath(dir, "b", "security");
    const conn = fakeConnection();
    let fileAtFirstOn: string | undefined;
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      if (msg.service === "turn_on" && fileAtFirstOn === undefined) {
        fileAtFirstOn = existsSync(file) ? readFileSync(file, "utf-8") : "";
      }
      return {};
    });
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_away");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
    await vi.waitFor(() => expect(fileAtFirstOn).toBeDefined());
    // A crash right after the dispatch must find the trip on disk: the
    // triggered snapshot and the exact alert set.
    const written = JSON.parse(fileAtFirstOn || "{}");
    expect(written.state).toMatchObject({
      mode: "away",
      phase: "triggered",
      activeAlerts: ["siren.a"],
    });
    await plugin.onShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the pending setters when the call rejects on a live connection object", async () => {
    const conn = fakeConnection();
    const listeners: Record<string, () => void> = {};
    conn.addEventListener = vi.fn((event: string, cb: () => void) => {
      listeners[event] = cb;
    });
    conn.sendMessagePromise = vi.fn(async (_msg: ServiceMessage) => {
      throw new Error("connection lost");
    });
    const storage = makeStorage();
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.arm_home",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_home");
    // hajs keeps the Connection object during a reconnect and rejects calls;
    // the intent must land in storage anyway.
    await vi.waitFor(() => {
      expect(storage.data.get("pendingSetters")).toEqual({ mode: "home" });
    });

    // The socket comes back. The replay hangs until released and the marker
    // must stay in storage the whole time.
    const seen: ServiceMessage[] = [];
    let releaseCall!: () => void;
    const gate = new Promise<void>((r) => {
      releaseCall = r;
    });
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      seen.push(msg);
      await gate;
      return {};
    });
    listeners.ready?.();
    await vi.waitFor(() =>
      expect(seen.some((m) => m.service === "turn_on")).toBe(true),
    );
    expect(storage.data.get("pendingSetters")).toEqual({ mode: "home" });
    releaseCall();
    await vi.waitFor(() =>
      expect(storage.data.get("pendingSetters")).toBeUndefined(),
    );
    await plugin.onShutdown();
  });

  it("holds the setters while the socket sits in its reconnect window", async () => {
    const conn = { ...fakeConnection(), connected: false };
    const storage = makeStorage();
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.arm_home",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_home");
    await vi.waitFor(() => {
      expect(storage.data.get("pendingSetters")).toEqual({ mode: "home" });
    });
    const on = conn.sendMessagePromise.mock.calls
      .map(([m]) => m)
      .filter((m) => m.service === "turn_on");
    expect(on).toEqual([]);
    await plugin.onShutdown();
  });

  it("frees the queue after the per-call deadline so a chasing silence still lands", async () => {
    vi.useFakeTimers();
    const conn = fakeConnection();
    const seen: ServiceMessage[] = [];
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      seen.push(msg);
      if (msg.service === "turn_on" && msg.target?.entity_id === "siren.a") {
        await new Promise(() => {});
      }
      return {};
    });
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        entryDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    await armVia(devices, "mode_away");
    plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.filter((m) => m.service === "turn_on")).toHaveLength(1);
    // Disarm while the turn_on hangs forever.
    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    const off = seen.filter((m) => m.service === "turn_off");
    expect(off.map((m) => m.target?.entity_id)).toEqual(["siren.a"]);
    await plugin.onShutdown();
  });

  it("keeps the effect queue bounded while a call hangs", async () => {
    const conn = fakeConnection();
    conn.sendMessagePromise = vi.fn(async (_msg: ServiceMessage) => {
      await new Promise(() => {});
      return {};
    });
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.h",
        awaySetters: "scene.a",
        offSetters: "scene.off",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    for (let i = 0; i < 25; i++) {
      await armVia(devices, "mode_home");
      await armVia(devices, "mode_away");
      await devices
        .get("mode_away")
        ?.onAttributeWrite?.("onOff", "onOff", false);
    }
    const tasks = (plugin as unknown as { tasks?: unknown[] }).tasks;
    expect(tasks?.length ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(3);
    await plugin.onShutdown();
  });

  it("silences a removed alert entity after a restart from triggered", async () => {
    const storage = makeStorage({
      state: {
        mode: "away",
        phase: "triggered",
        modeReached: true,
        activeAlerts: ["siren.old"],
      },
    });
    const conn = fakeConnection();
    const { ctx, devices } = createMockContext({
      storage: storage as unknown as PluginStorage,
      homeAssistant: ha,
    });
    // siren.old was removed from the config while the alarm stood tripped.
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        triggerTimeSeconds: 0,
        awayTriggers: "binary_sensor.door",
        awayAlerts: "siren.new",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await devices.get("mode_away")?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.waitFor(() => {
      const off = conn.sendMessagePromise.mock.calls
        .map(([m]) => m)
        .filter((m) => m.service === "turn_off");
      expect(off.map((m) => m.target?.entity_id)).toEqual(["siren.old"]);
    });
    await plugin.onShutdown();
  });

  it("drops queued effect tasks on teardown so a re-enable does not replay them (#439 review)", async () => {
    const conn = fakeConnection();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: ServiceMessage[] = [];
    conn.sendMessagePromise = vi.fn(async (msg: ServiceMessage) => {
      seen.push(msg);
      if (msg.target?.entity_id === "scene.h") {
        await gate;
      }
      return {};
    });
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        homeTriggers: "binary_sensor.motion",
        homeSetters: "scene.h",
        awaySetters: "scene.a",
      },
      { connect: async () => conn as unknown as Connection },
    );
    await plugin.onStart(ctx);
    await vi.waitFor(() => expect(conn.subscribeEvents).toHaveBeenCalled());
    await armVia(devices, "mode_home");
    await vi.waitFor(() =>
      expect(seen.some((m) => m.target?.entity_id === "scene.h")).toBe(true),
    );
    // The away setters queue behind the hung home call.
    await armVia(devices, "mode_away");

    await plugin.onShutdown();
    await plugin.onStart(ctx);
    await vi.waitFor(() =>
      expect(conn.subscribeEvents).toHaveBeenCalledTimes(2),
    );
    release();
    await new Promise((r) => setTimeout(r, 30));

    // The queued away batch belonged to the closed generation; firing it now
    // would replay a stale setter against the new connection.
    const staleOn = seen.filter(
      (m) => m.service === "turn_on" && m.target?.entity_id === "scene.a",
    );
    expect(staleOn).toEqual([]);
    await plugin.onShutdown();
  });

  it("rewires triggers on config change and keeps the arm state", async () => {
    const conn = fakeConnection();
    const connect = vi.fn(async () => conn as unknown as Connection);
    const { ctx, devices } = createMockContext({ homeAssistant: ha });
    const plugin = new SecurityPlugin(
      {
        exitDelaySeconds: 0,
        triggerTimeSeconds: 0,
        homeTriggers: "binary_sensor.old",
      },
      { connect },
    );
    await plugin.onStart(ctx);
    await armVia(devices, "mode_home");

    await plugin.onConfigChanged({
      exitDelaySeconds: 0,
      triggerTimeSeconds: 0,
      homeTriggers: "binary_sensor.new",
    });
    // The connection was torn down and re-dialed.
    expect(conn.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    // Still armed home: the new trigger trips the alarm.
    plugin.handleTriggerEvent("binary_sensor.new", "on", "motion");
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "alarm",
      "booleanState",
      {
        stateValue: false,
      },
    );
    await plugin.onShutdown();
  });
});
