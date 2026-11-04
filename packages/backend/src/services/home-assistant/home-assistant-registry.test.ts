import type { Connection } from "home-assistant-js-websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeAssistantClient } from "./home-assistant-client.js";
import { HomeAssistantRegistry } from "./home-assistant-registry.js";

type Listener = () => void;

function makeConnection(opts?: { initiallyConnected?: boolean }) {
  const listeners: Listener[] = [];
  let connected = opts?.initiallyConnected ?? true;
  const conn = {
    get connected() {
      return connected;
    },
    addEventListener: vi.fn((_: string, cb: Listener) => {
      listeners.push(cb);
    }),
    removeEventListener: vi.fn((_: string, cb: Listener) => {
      const idx = listeners.indexOf(cb);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    sendMessagePromise: vi.fn(),
  };
  return {
    connection: conn as unknown as Connection,
    fireReady: () => {
      connected = true;
      for (const cb of listeners.slice()) cb();
    },
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

const lostError = () => ({
  type: "result",
  success: false,
  error: { code: 3, message: "Connection lost" },
});

const defaultOptions = {
  url: "http://x",
  accessToken: "t",
  refreshInterval: 60,
  messageTimeoutMs: 60_000,
};

describe("HomeAssistantRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("group sensor startup", () => {
    function makeGroupRegistry(
      state: string | undefined,
      attributes: Record<string, string> = {},
      entityOverrides: Record<string, string> = {},
    ) {
      const fake = makeConnection();
      const entity = {
        entity_id: "sensor.bathroom_temperature",
        platform: "group",
        ...entityOverrides,
      };
      const snapshot = {
        states:
          state === undefined
            ? []
            : [{ entity_id: entity.entity_id, state, attributes }],
      };
      fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
        Promise.resolve(
          message.type === "config/entity_registry/list"
            ? [entity]
            : message.type === "get_states"
              ? snapshot.states
              : [],
        ),
      ) as unknown as Connection["sendMessagePromise"];
      const registry = new HomeAssistantRegistry(
        { connection: fake.connection, haRunning: true } as HomeAssistantClient,
        defaultOptions,
      );
      return { registry, snapshot, connection: fake.connection };
    }

    it.each([
      undefined,
      "unknown",
      "unavailable",
    ])("waits for a %s group sensor before allowing bridges to initialize", async (state) => {
      const { registry, snapshot } = makeGroupRegistry(state);
      const initialized = vi.fn();
      void registry.construction.then(initialized);
      await vi.advanceTimersByTimeAsync(1);
      expect(initialized).not.toHaveBeenCalled();

      snapshot.states = [
        {
          entity_id: "sensor.bathroom_temperature",
          state: "23.7",
          attributes: {
            device_class: "temperature",
            unit_of_measurement: "°C",
          },
        },
      ];
      await vi.advanceTimersByTimeAsync(2998);
      expect(initialized).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await registry.construction;
      expect(initialized).toHaveBeenCalledOnce();
      expect(
        registry.states["sensor.bathroom_temperature"].attributes,
      ).toMatchObject({ device_class: "temperature" });
    });

    it.each<[string, Record<string, string>, Record<string, string>]>([
      ["unavailable", { device_class: "temperature" }, {}],
      ["42", {}, {}],
      ["unavailable", {}, { disabled_by: "user" }],
      ["unavailable", {}, { platform: "mqtt" }],
      ["unavailable", {}, { entity_id: "light.group" }],
    ])("does not delay a usable or unrelated entity (%j)", async (state, attributes, overrides) => {
      const { registry } = makeGroupRegistry(state, attributes, overrides);
      const initialized = vi.fn();
      void registry.construction.then(initialized);
      await vi.advanceTimersByTimeAsync(1);
      expect(initialized).toHaveBeenCalledOnce();
    });

    it("bounds the wait for a group whose members stay offline", async () => {
      const { registry, connection } = makeGroupRegistry("unavailable");
      const initialized = vi.fn();
      void registry.construction.then(initialized);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(initialized).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(initialized).toHaveBeenCalledOnce();
      expect(
        vi
          .mocked(connection.sendMessagePromise)
          .mock.calls.filter(([message]) => message.type === "get_states"),
      ).toHaveLength(21);
    });
  });

  it("initialize survives a registry fetch that never recovers", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn().mockRejectedValue(lostError());
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
    expect(Object.keys(registry.entities)).toHaveLength(0);
    expect(Object.keys(registry.devices)).toHaveLength(0);
  });

  it("recovers within a single attempt when a mid-flight drop is followed by success", async () => {
    const fake = makeConnection();
    let phase = 0;
    fake.connection.sendMessagePromise = vi.fn(() => {
      if (phase === 0) {
        phase = 1;
        return Promise.reject(lostError());
      }
      return Promise.resolve([]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.advanceTimersByTimeAsync(50);
    fake.setConnected(false);
    fake.fireReady();
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
  });

  it("propagates non-connection errors to withRetry", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi
      .fn()
      .mockRejectedValue(new Error("bad request"));
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);

    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await expect(initPromise).resolves.toBeUndefined();
    expect(fake.connection.sendMessagePromise).toHaveBeenCalled();
  });

  it("holds the trusted fingerprint and generation through a starting-HA window (#438)", async () => {
    const fake = makeConnection();
    let entityList: unknown[] = [];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/entity_registry/list" ? entityList : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await initPromise;
    const g0 = registry.snapshotGeneration;
    expect(g0).toBeGreaterThan(0);

    // HA restarts, a partial snapshot arrives while it is still STARTING.
    // Neither the generation nor the fingerprint may move.
    client.haRunning = false;
    entityList = [{ entity_id: "light.a" }];
    await registry.reload();
    expect(registry.snapshotGeneration).toBe(g0);

    // The first RUNNING reload with the very same data must still read as
    // changed, so the managers reconcile what the partial snapshots skipped.
    client.haRunning = true;
    await expect(registry.reload()).resolves.toBe(true);
    expect(registry.snapshotGeneration).toBe(g0 + 1);
  });

  it("keeps the last labels when the label query fails (#500)", async () => {
    const fake = makeConnection();
    let labelsFail = false;
    let devices: unknown[] = [];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      if (message.type === "config/device_registry/list") {
        return Promise.resolve(devices);
      }
      if (message.type !== "config/label_registry/list") {
        return Promise.resolve([]);
      }
      return labelsFail
        ? Promise.reject(new Error("timed out"))
        : Promise.resolve([{ label_id: "voice_2", name: "Voice" }]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await initPromise;
    expect(registry.labels).toHaveLength(1);

    labelsFail = true;
    await expect(registry.reload()).resolves.toBe(false);
    expect(registry.labels).toEqual([{ label_id: "voice_2", name: "Voice" }]);

    // a rebuild for another reason must not empty them either
    devices = [{ id: "d1", name: "Oven" }];
    await expect(registry.reload()).resolves.toBe(true);
    expect(registry.labels).toEqual([{ label_id: "voice_2", name: "Voice" }]);
  });

  it("keeps the last areas when the area query fails", async () => {
    const fake = makeConnection();
    let areasFail = false;
    let devices: unknown[] = [];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      if (message.type === "config/device_registry/list") {
        return Promise.resolve(devices);
      }
      if (message.type !== "config/area_registry/list") {
        return Promise.resolve([]);
      }
      return areasFail
        ? Promise.reject(new Error("timed out"))
        : Promise.resolve([{ area_id: "kitchen", name: "Kitchen" }]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await initPromise;
    expect(registry.areas.get("kitchen")).toBe("Kitchen");

    // unchanged fingerprint, so no full rebuild
    areasFail = true;
    await expect(registry.reload()).resolves.toBe(false);
    expect(registry.areas.get("kitchen")).toBe("Kitchen");

    devices = [{ id: "d1", name: "Oven" }];
    await expect(registry.reload()).resolves.toBe(true);
    expect(registry.areas.get("kitchen")).toBe("Kitchen");
  });

  // #467: onRefresh only runs when the fingerprint moved, so a field missing
  // from the hash never reaches the endpoints at all.
  it("notices a device manufacturer, model_id or firmware change (#467)", async () => {
    const fake = makeConnection();
    let devices: unknown[] = [
      { id: "d1", name: "Oven", manufacturer: "OldMfr", sw_version: "1.0" },
    ];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/device_registry/list" ? devices : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await initPromise;

    // same data, nothing to do
    await expect(registry.reload()).resolves.toBe(false);

    devices = [
      { id: "d1", name: "Oven", manufacturer: "NewMfr", sw_version: "1.0" },
    ];
    await expect(registry.reload()).resolves.toBe(true);

    devices = [
      { id: "d1", name: "Oven", manufacturer: "NewMfr", sw_version: "2.0" },
    ];
    await expect(registry.reload()).resolves.toBe(true);

    devices = [
      {
        id: "d1",
        name: "Oven",
        manufacturer: "NewMfr",
        sw_version: "2.0",
        model_id: "M2",
      },
    ];
    await expect(registry.reload()).resolves.toBe(true);
  });

  it("does not trust a snapshot fetched while HA was still starting, even if it turns RUNNING mid-fetch (#438)", async () => {
    const fake = makeConnection();
    const client = {
      connection: fake.connection,
      haRunning: false,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      // HA reaches RUNNING while this very fetch is in flight.
      client.haRunning = true;
      return Promise.resolve(
        message.type === "config/entity_registry/list"
          ? [{ entity_id: "light.partial" }]
          : [],
      );
    }) as unknown as Connection["sendMessagePromise"];
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    const initPromise = registry.construction;
    await vi.runAllTimersAsync();
    await initPromise;

    // The fetch started untrusted, so nothing it returned may confirm a
    // removal, and the next full RUNNING reload must still read as changed.
    expect(registry.snapshotGeneration).toBe(0);
    await expect(registry.reload()).resolves.toBe(true);
    expect(registry.snapshotGeneration).toBe(1);
  });

  it("discards a snapshot that started trusted but lost HA before it finished (#438)", async () => {
    const fake = makeConnection();
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    let dropDuringFetch = false;
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      if (dropDuringFetch) client.haRunning = false;
      return Promise.resolve(
        message.type === "config/entity_registry/list"
          ? [{ entity_id: "light.a" }]
          : [],
      );
    }) as unknown as Connection["sendMessagePromise"];
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;
    const generation = registry.snapshotGeneration;

    // HA drops mid-fetch: whatever came back is a torn read.
    dropDuringFetch = true;
    await expect(registry.reload()).resolves.toBe(false);
    expect(registry.snapshotGeneration).toBe(generation);
  });

  it("reports changed after an HA-down window even when nothing in HA changed (#438)", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/entity_registry/list"
          ? [{ entity_id: "light.a" }]
          : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;
    await expect(registry.reload()).resolves.toBe(false);

    // Bridges skipped every reconcile while HA was down, so the first good
    // reload has to drive one even though the registry is identical.
    client.haRunning = false;
    await registry.reload();
    client.haRunning = true;
    await expect(registry.reload()).resolves.toBe(true);
  });

  it("refreshes bridges after an HA restart it never saw (#438)", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/entity_registry/list"
          ? [{ entity_id: "light.a" }]
          : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
      runningSince: 1_000,
    } as unknown as HomeAssistantClient & { runningSince: number };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;

    const onRefresh = vi.fn();
    registry.enableAutoRefresh(onRefresh);
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    onRefresh.mockClear();

    // HA restarted between two ticks, so the registry never saw it go down
    // and its content is unchanged. Bridges still need one reconcile.
    client.runningSince = 2_000;
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Steady state stays quiet.
    onRefresh.mockClear();
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    expect(onRefresh).not.toHaveBeenCalled();
    registry.disableAutoRefresh();
  });

  it("a failed reload does not consume the pending restart (#438)", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/entity_registry/list"
          ? [{ entity_id: "light.a" }]
          : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
      runningSince: 1_000,
    } as unknown as HomeAssistantClient & { runningSince: number };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;

    const onRefresh = vi.fn();
    registry.enableAutoRefresh(onRefresh);
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    onRefresh.mockClear();

    // HA restarted, but the first reload after it fails outright.
    client.runningSince = 2_000;
    const reload = vi
      .spyOn(registry, "reload")
      .mockRejectedValueOnce(new Error("boom"));
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    expect(onRefresh).not.toHaveBeenCalled();

    // The next good reload still owes the bridges their reconcile.
    reload.mockRestore();
    await vi.advanceTimersByTimeAsync(defaultOptions.refreshInterval * 1000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    registry.disableAutoRefresh();
  });

  it("keeps the last trusted registry contents through an untrusted reload (#438)", async () => {
    const fake = makeConnection();
    let entityList: unknown[] = [
      { entity_id: "light.a" },
      { entity_id: "light.b" },
    ];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(
        message.type === "config/entity_registry/list" ? entityList : [],
      ),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient & { haRunning: boolean };
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;
    expect(Object.keys(registry.entities).sort()).toEqual([
      "light.a",
      "light.b",
    ]);

    // HA restarts and serves a partial list. The cached registry must not
    // take it, or a later removal would confirm against the missing entity.
    client.haRunning = false;
    entityList = [{ entity_id: "light.a" }];
    await registry.reload();
    expect(Object.keys(registry.entities).sort()).toEqual([
      "light.a",
      "light.b",
    ]);
  });

  it("times out a hung get_states query instead of blocking Promise.all forever", async () => {
    const fake = makeConnection();
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) => {
      if (message.type === "get_states") {
        // The socket stays open but never answers this one query.
        return new Promise(() => {});
      }
      return Promise.resolve([]);
    }) as unknown as Connection["sendMessagePromise"];
    const client = { connection: fake.connection } as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, {
      ...defaultOptions,
      messageTimeoutMs: 50,
    });
    const internal = registry as unknown as {
      runRegistryQueries(): Promise<boolean>;
    };

    const outcome = internal.runRegistryQueries().then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    // Bounds the assertion in fake-timer time so a still-hanging query fails
    // the expectation cleanly instead of tripping vitest's real-time timeout.
    const probe = new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 1000);
    });

    const race = Promise.race([outcome, probe]);
    await vi.runAllTimersAsync();
    await expect(race).resolves.toBe("rejected");
  });

  it("keeps a subscription state newer than the fetched snapshot", async () => {
    const fake = makeConnection();
    const at = (id: string, state: string, ts: string) => ({
      entity_id: id,
      state,
      attributes: {},
      last_updated: ts,
    });
    let statesList = [
      at("light.a", "off", "2026-01-01T00:00:01.000000+00:00"),
      at("light.b", "off", "2026-01-01T00:00:01.000000+00:00"),
    ];
    fake.connection.sendMessagePromise = vi.fn((message: { type: string }) =>
      Promise.resolve(message.type === "get_states" ? statesList : []),
    ) as unknown as Connection["sendMessagePromise"];
    const client = {
      connection: fake.connection,
      haRunning: true,
    } as unknown as HomeAssistantClient;
    const registry = new HomeAssistantRegistry(client, defaultOptions);
    await vi.runAllTimersAsync();
    await registry.construction;

    // an event merged while the next get_states was in flight
    const merged = at("light.a", "on", "2026-01-01T00:00:03.000Z");
    registry.states["light.a"] = merged as never;
    statesList = [
      at("light.a", "off", "2026-01-01T00:00:02.000000+00:00"),
      at("light.b", "on", "2026-01-01T00:00:02.000000+00:00"),
    ];
    await registry.reload();
    expect(registry.states["light.a"]).toBe(merged);
    expect(registry.states["light.b"].state).toBe("on");
  });
});
