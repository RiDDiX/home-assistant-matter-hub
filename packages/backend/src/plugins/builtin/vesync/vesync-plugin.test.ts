import { createHash } from "node:crypto";
import type { Logger } from "@matter/general";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginDevice } from "../../types.js";
import { VeSyncPlugin } from "./vesync-plugin.js";

const AUTH = "/globalPlatform/api/accountAuth/v1/authByPWDOrOTM";
const LOGIN = "/user/api/accountManage/v1/loginByAuthorizeCode4Vesync";
const DEVICES = "/cloud/v1/deviceManaged/devices";
const V2 = "/cloud/v2/deviceManaged/bypassV2";

const EMAIL = "someone@example.com";
const PASSWORD = "pw-Secret-42";
const PASSWORD_MD5 = createHash("md5").update(PASSWORD).digest("hex");
const AUTH_CODE = "authcode-77";

type Json = Record<string, unknown>;

const row = (cid: string, deviceName: string, deviceType: string) => ({
  cid,
  deviceName,
  deviceType,
  configModule: `module-${cid}`,
  connectionStatus: "online",
});
type Row = ReturnType<typeof row>;

const FRYER = row("fryer-1", "Fryer", "CAF-TF102S");
const AIR = row("air-1", "Purifier", "Core300S");
const OUTDOOR = row("outdoor", "Outdoor", "ESO15-TB");

const fryerStatus = (left: string) => ({
  statusList: [
    { cookStatus: left, chamber: 1 },
    { cookStatus: "standby", chamber: 2 },
  ],
  syncType: 0,
  workChamber: 1,
});

const reply = (json: unknown) =>
  ({ status: 200, json: async () => json }) as unknown as Response;
const ok = (result: unknown) => ({ code: 0, msg: "ok", result });

// In-memory VeSync cloud. A device without a status answers offline.
function fakeCloud(rows: Row[], status: Record<string, Json> = {}) {
  const calls: { path: string; body: Json }[] = [];
  let logins = 0;
  const answer = (path: string, body: Json) => {
    if (path === AUTH) {
      return cloud.authCode
        ? { code: cloud.authCode, msg: `refused ${EMAIL}` }
        : ok({ accountID: "1", authorizeCode: AUTH_CODE });
    }
    if (path === LOGIN) {
      logins++;
      return ok({ token: `tok-${logins}`, accountID: "1", countryCode: "US" });
    }
    if (path === DEVICES) return ok({ total: rows.length, list: rows });
    const s = status[String(body.cid)];
    if (!s) return { code: -11300000, msg: "device offline" };
    const method = String((body.payload as Json).method);
    return ok({ code: 0, result: method.startsWith("get") ? s : {} });
  };
  const cloud = {
    calls,
    status,
    authCode: 0,
    hang: false,
    down: false,
    // cids whose requests fail like an unreachable host
    dead: new Set<string>(),
    // matching requests wait for release()
    hold: undefined as ((path: string, body: Json) => boolean) | undefined,
    held: [] as (() => void)[],
    release: () => {
      for (const go of cloud.held.splice(0)) go();
    },
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Json;
      calls.push({ path, body });
      if (cloud.hang) return new Promise<Response>(() => {});
      if (cloud.hold?.(path, body)) {
        await new Promise<void>((go) => cloud.held.push(go));
      }
      if (cloud.down || cloud.dead.has(String(body.cid))) {
        throw new TypeError("fetch failed");
      }
      return reply(answer(path, body));
    }),
    count: (path: string) => calls.filter((c) => c.path === path).length,
    v2: () =>
      calls
        .filter((c) => c.path === V2)
        .map((c): Json => ({ cid: c.body.cid, ...(c.body.payload as Json) })),
  };
  return cloud;
}

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

function createMockContext(seed: Record<string, unknown> = {}) {
  const devices = new Map<string, PluginDevice>();
  const logs: unknown[][] = [];
  const record = (...args: unknown[]) => {
    logs.push(args);
  };
  const storage = makeStorage(seed);
  const ctx = {
    bridgeId: "b",
    log: { debug: record, info: record, warn: record, error: record },
    storage,
    registerDevice: vi.fn(async (device: PluginDevice) => {
      devices.set(device.id, device);
    }),
    unregisterDevice: vi.fn(async (id: string) => {
      devices.delete(id);
    }),
    updateDeviceState: vi.fn(),
    registerDomainMapping: vi.fn(),
  };
  return {
    ctx: ctx as unknown as PluginContext & { log: Logger },
    devices,
    storage,
    logs,
  };
}

const config = (extra: Json = {}) => ({
  email: EMAIL,
  password: PASSWORD,
  ...extra,
});

// what the plugin stores next to a session and device list of EMAIL
const ACCOUNT = createHash("sha256")
  .update(`${EMAIL}\0${PASSWORD}`)
  .digest("hex");

const cached = (r: Row) => ({
  cid: r.cid,
  name: r.deviceName,
  deviceType: r.deviceType,
  configModule: r.configModule,
  online: true,
});

const status = (plugin: VeSyncPlugin) => plugin.getConfigSchema().description;

// Starts with the given devices exposed and waits for the first poll.
async function running(
  rows: Row[],
  state: Record<string, Json>,
  exposed: string[] = rows.map((r) => r.cid),
  extra: Json = {},
) {
  const cloud = fakeCloud(rows, state);
  const mock = createMockContext({
    config: config({
      ...Object.fromEntries(exposed.map((c) => [`expose_${c}`, true])),
      ...extra,
    }),
    devices: rows.map(cached),
    account: ACCOUNT,
  });
  const plugin = new VeSyncPlugin({ fetch: cloud.fetch });
  await plugin.onStart(mock.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(status(plugin)).toContain("signed in");
  return { cloud, plugin, ...mock };
}

function expectNoSecrets(plugin: VeSyncPlugin, logs: unknown[][]) {
  const text = JSON.stringify([plugin.getConfigSchema(), logs]);
  for (const secret of [EMAIL, PASSWORD, PASSWORD_MD5, AUTH_CODE, "tok-"]) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VeSyncPlugin", () => {
  it("registers nothing and calls no cloud while not configured", async () => {
    const cloud = fakeCloud([FRYER]);
    const { ctx } = createMockContext();
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(ctx.registerDevice).not.toHaveBeenCalled();
    expect(cloud.fetch).not.toHaveBeenCalled();
    expect(status(plugin)).toBe("Status: not configured.");
    await plugin.onShutdown();
  });

  it("mounts cached devices before any network and resolves while the cloud hangs", async () => {
    const cloud = fakeCloud([FRYER]);
    cloud.hang = true;
    const { ctx, devices, storage } = createMockContext({
      config: config({ "expose_fryer-1": true }),
      devices: [cached(FRYER)],
      account: ACCOUNT,
    });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);

    expect(cloud.fetch).not.toHaveBeenCalled();
    expect([...devices.values()]).toEqual([
      {
        id: "vesync_fryer-1_left",
        name: "Fryer Left",
        deviceType: "on_off_plugin_unit",
        clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        onAttributeWrite: expect.any(Function),
      },
      expect.objectContaining({ id: "vesync_fryer-1_right" }),
    ]);
    expect(storage.data.get("terminalId")).toMatch(/^2[0-9a-f]{32}$/);

    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.calls.map((c) => c.path)).toEqual([AUTH]);
    expect(status(plugin)).toBe("Status: signing in.");
    await plugin.onShutdown();
    expect(devices.size).toBe(0);
  });

  it("lists discovered devices in the schema and keeps the session out of the config", async () => {
    const cloud = fakeCloud([FRYER, AIR, OUTDOOR]);
    const { ctx, storage, logs } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);

    const schema = plugin.getConfigSchema();
    expect(schema.description).toBe(
      "Status: signed in, 3 devices found. Not supported yet: Outdoor (ESO15-TB).",
    );
    expect(Object.keys(schema.properties)).toEqual([
      "email",
      "password",
      "pollInterval",
      "expose_fryer-1",
      "expose_air-1",
    ]);
    expect(schema.properties.password.secret).toBe(true);
    expect(schema.properties["expose_air-1"]).toEqual({
      type: "boolean",
      title: "Purifier",
      description: "Air purifier, Core300S",
      default: false,
    });
    expect(ctx.registerDevice).not.toHaveBeenCalled();
    expect(storage.data.get("session")).toMatchObject({ token: "tok-1" });
    expect(storage.data.get("devices")).toHaveLength(3);
    expect(Object.keys(plugin.getCurrentConfig())).toEqual([
      "email",
      "password",
    ]);
    expectNoSecrets(plugin, logs);
    await plugin.onShutdown();
  });

  it("mounts and unmounts a device when its switch flips, without the cloud", async () => {
    const cloud = fakeCloud([AIR]);
    const { ctx, devices } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });
    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    cloud.hang = true;

    await plugin.onConfigChanged(config({ "expose_air-1": true }));
    expect([...devices.keys()]).toEqual(["vesync_air-1"]);
    expect(devices.get("vesync_air-1")).toMatchObject({
      name: "Purifier",
      deviceType: "air_purifier",
      clusters: [
        {
          clusterId: "fanControl",
          attributes: {
            fanModeSequence: 0,
            fanMode: 0,
            percentSetting: 0,
            percentCurrent: 0,
          },
        },
      ],
    });

    await plugin.onConfigChanged(config({ "expose_air-1": false }));
    expect(devices.size).toBe(0);
    expect(ctx.unregisterDevice).toHaveBeenCalledWith("vesync_air-1");
    await plugin.onShutdown();
  });

  it("drops the session and the device list when the account changes", async () => {
    const { cloud, plugin, ctx, devices, storage } = await running([AIR], {
      "air-1": { enabled: true, level: 1, mode: "manual" },
    });
    expect(devices.size).toBe(1);
    cloud.hang = true;

    await plugin.onConfigChanged(
      config({ email: "other@example.com", "expose_air-1": true }),
    );

    expect(storage.data.has("session")).toBe(false);
    expect(storage.data.get("devices")).toEqual([]);
    expect(devices.size).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.calls.at(-1)?.body.email).toBe("other@example.com");
    expect(ctx.registerDevice).toHaveBeenCalledTimes(1);
    await plugin.onShutdown();
  });

  it("drops a session and device list stored for other credentials", async () => {
    // an account saved while the plugin was disabled reaches onStart only
    const cloud = fakeCloud([AIR]);
    cloud.hang = true;
    const { ctx, storage } = createMockContext({
      config: config({ email: "other@example.com", "expose_air-1": true }),
      session: {
        token: "old-token",
        accountId: "1",
        countryCode: "US",
        region: "US",
      },
      devices: [cached(AIR)],
      account: ACCOUNT,
    });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.registerDevice).not.toHaveBeenCalled();
    expect(storage.data.has("session")).toBe(false);
    expect(cloud.calls.map((c) => c.path)).toEqual([AUTH]);
    expect(cloud.calls[0].body.email).toBe("other@example.com");
    await plugin.onShutdown();
  });

  it("drops a sign-in that finishes after shutdown", async () => {
    const cloud = fakeCloud([AIR]);
    cloud.hold = (path) => path === AUTH;
    const { ctx, storage } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });
    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    await plugin.onShutdown();
    storage.set.mockClear();

    cloud.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(cloud.calls.map((c) => c.path)).toEqual([AUTH, LOGIN]);
    expect(storage.set).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a device list that arrives after an account switch", async () => {
    const cloud = fakeCloud([AIR]);
    cloud.hold = (path) => path === DEVICES;
    const { ctx, storage } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });
    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.held).toHaveLength(1);
    cloud.hang = true;

    await plugin.onConfigChanged(
      config({ email: "other@example.com", "expose_air-1": true }),
    );
    cloud.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.data.get("devices")).toEqual([]);
    expect(ctx.registerDevice).not.toHaveBeenCalled();
    expect(Object.keys(plugin.getConfigSchema().properties)).not.toContain(
      "expose_air-1",
    );
    await plugin.onShutdown();
  });

  it("stops after a wrong password until the config changes", async () => {
    const cloud = fakeCloud([AIR]);
    cloud.authCode = -11202022;
    const { ctx, logs } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);

    expect(cloud.count(AUTH)).toBe(1);
    expect(status(plugin)).toBe(
      "Status: sign-in failed: wrong email or password.",
    );
    expect(vi.getTimerCount()).toBe(0);
    expectNoSecrets(plugin, logs);

    cloud.authCode = 0;
    await plugin.onConfigChanged(config({ pollInterval: 120 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.count(AUTH)).toBe(2);
    expect(status(plugin)).toBe("Status: signed in, 1 device found.");
    await plugin.onShutdown();
  });

  it("says so when the account uses two-factor sign-in", async () => {
    const cloud = fakeCloud([]);
    cloud.authCode = -11257129;
    const { ctx } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(cloud.count(AUTH)).toBe(1);
    expect(status(plugin)).toBe(
      "Status: this account uses two-factor sign-in, which is not supported.",
    );
    await plugin.onShutdown();
  });

  it("marks the cached units unreachable when the sign-in is refused", async () => {
    const cloud = fakeCloud([AIR]);
    cloud.authCode = -11202022;
    const { ctx } = createMockContext({
      config: config({ "expose_air-1": true }),
      devices: [cached(AIR)],
      account: ACCOUNT,
    });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_air-1",
      "bridgedDeviceBasicInformation",
      { reachable: false },
    );
    await plugin.onShutdown();
  });

  it("backs off from 10 s on network failures and waits an hour on quota", async () => {
    const cloud = fakeCloud([]);
    cloud.down = true;
    const { ctx } = createMockContext({ config: config() });
    const plugin = new VeSyncPlugin({ fetch: cloud.fetch });

    await plugin.onStart(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(cloud.count(AUTH)).toBe(1);
    expect(status(plugin)).toBe("Status: cloud unreachable, retrying.");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cloud.count(AUTH)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.count(AUTH)).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(cloud.count(AUTH)).toBe(3);

    cloud.down = false;
    cloud.authCode = -16906086;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(cloud.count(AUTH)).toBe(4);
    expect(status(plugin)).toBe(
      "Status: daily request quota used up, retrying later.",
    );
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(cloud.count(AUTH)).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloud.count(AUTH)).toBe(5);
    await plugin.onShutdown();
  });

  it("backs off the same way when the cloud goes down after sign-in", async () => {
    const { plugin, cloud } = await running([AIR], {
      "air-1": { enabled: true, level: 1, mode: "manual" },
    });
    cloud.down = true;
    const start = cloud.count(V2);

    for (const [wait, polls] of [
      [60_000, 1],
      [9_999, 1],
      [1, 2],
      [19_999, 2],
      [1, 3],
      [39_999, 3],
      [1, 4],
    ]) {
      await vi.advanceTimersByTimeAsync(wait);
      expect(cloud.count(V2)).toBe(start + polls);
    }
    expect(status(plugin)).toBe("Status: cloud unreachable, retrying.");
    await plugin.onShutdown();
  });

  it("keeps polling the other devices when one cannot be reached", async () => {
    const hall = row("air-2", "Hall", "Core300S");
    const { ctx, plugin, cloud } = await running([AIR, hall], {
      "air-1": { enabled: true, level: 1, mode: "manual" },
      "air-2": { enabled: true, level: 1, mode: "manual" },
    });
    const polled = (cid: string) =>
      cloud.v2().filter((c) => c.cid === cid).length;
    cloud.dead.add("air-1");
    cloud.status["air-2"] = { enabled: true, level: 3, mode: "manual" };

    await vi.advanceTimersByTimeAsync(60_000);
    expect(polled("air-1")).toBe(2);
    expect(polled("air-2")).toBe(2);
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_air-2",
      "fanControl",
      { fanMode: 3, percentSetting: 100, percentCurrent: 100 },
    );
    expect(status(plugin)).toBe("Status: signed in, 2 devices found.");
    // 10 s is the failure retry; the cycle finished
    await vi.advanceTimersByTimeAsync(59_999);
    expect(polled("air-1")).toBe(2);
    await plugin.onShutdown();
  });

  it("shares the request quota with the other bridges on the account", async () => {
    const state = { "fryer-1": fryerStatus("standby") };
    const a = await running([FRYER], state, ["fryer-1"], { pollInterval: 30 });
    const b = await running([FRYER], state, ["fryer-1"], { pollInterval: 30 });
    const polls = b.cloud.count(V2);

    // one device polled by two bridges: 46 s keeps both under 80 % of 4700
    await vi.advanceTimersByTimeAsync(45_999);
    expect(b.cloud.count(V2)).toBe(polls);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.cloud.count(V2)).toBe(polls + 1);

    // the 46 s timer is already armed; the next cycle is 30 s alone
    await a.plugin.onShutdown();
    await vi.advanceTimersByTimeAsync(46_000 + 30_000);
    expect(b.cloud.count(V2)).toBe(polls + 3);
    await b.plugin.onShutdown();
  });

  it("pushes the polled state and keeps polling past an offline device", async () => {
    const offline = row("fryer-2", "Old fryer", "CAF-TF101S");
    const { ctx, plugin } = await running([offline, AIR], {
      "air-1": { enabled: true, level: 2, mode: "manual" },
    });

    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_fryer-2_left",
      "bridgedDeviceBasicInformation",
      { reachable: false },
    );
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_air-1",
      "fanControl",
      { fanMode: 2, percentSetting: 66, percentCurrent: 66 },
    );
    await plugin.onShutdown();
  });

  it("shows auto mode as the running third, matter.js refuses fanMode Auto", async () => {
    const { ctx, plugin } = await running([AIR], {
      "air-1": { enabled: true, level: 1, mode: "auto" },
    });

    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_air-1",
      "fanControl",
      { fanMode: 1, percentSetting: 33, percentCurrent: 33 },
    );
    await plugin.onShutdown();
  });

  it("pushes a fryer on write back to off without a command", async () => {
    const { ctx, plugin, devices, cloud } = await running([FRYER], {
      "fryer-1": fryerStatus("standby"),
    });
    const before = cloud.v2().length;
    vi.mocked(ctx.updateDeviceState).mockClear();

    await devices
      .get("vesync_fryer-1_right")
      ?.onAttributeWrite?.("onOff", "onOff", true);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(
      cloud
        .v2()
        .slice(before)
        .map((c) => c.method),
    ).toEqual(["getAirfryerMultiStatus"]);
    expect(ctx.updateDeviceState).toHaveBeenLastCalledWith(
      "vesync_fryer-1_right",
      "onOff",
      { onOff: false },
    );
    await plugin.onShutdown();
  });

  it("reads again after a refused write dropped an overlapping poll", async () => {
    const { ctx, plugin, devices, cloud } = await running([FRYER], {
      "fryer-1": fryerStatus("standby"),
    });
    cloud.hold = (path) => path === V2;
    await vi.advanceTimersByTimeAsync(60_000);
    cloud.hold = undefined;
    // cooking is live now; the in-flight read still has standby
    cloud.status["fryer-1"] = fryerStatus("cooking");
    await devices
      .get("vesync_fryer-1_left")
      ?.onAttributeWrite?.("onOff", "onOff", true);
    cloud.release();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(ctx.updateDeviceState).mockClear();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_fryer-1_left",
      "onOff",
      { onOff: true },
    );
    expect(cloud.v2().some((c) => c.method === "endCook")).toBe(false);
    await plugin.onShutdown();
  });

  it("sends endCook for a fryer off write and polls again 2 s later", async () => {
    const { plugin, devices, cloud } = await running([FRYER], {
      "fryer-1": fryerStatus("cooking"),
    });
    const reads = () =>
      cloud.v2().filter((c) => c.method === "getAirfryerMultiStatus").length;
    const polled = reads();

    await devices
      .get("vesync_fryer-1_left")
      ?.onAttributeWrite?.("onOff", "onOff", false);

    expect(cloud.v2().at(-1)).toEqual({
      cid: "fryer-1",
      method: "endCook",
      source: "APP",
      data: { chamber: 1 },
      subDeviceNo: 0,
      subDeviceType: "",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(reads()).toBe(polled);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(polled + 1);
    await plugin.onShutdown();
  });

  it("ignores the echo of a pushed value and attributes it never pushed", async () => {
    const { ctx, plugin, devices, cloud } = await running([FRYER], {
      "fryer-1": fryerStatus("cooking"),
    });
    expect(ctx.updateDeviceState).toHaveBeenCalledWith(
      "vesync_fryer-1_left",
      "onOff",
      { onOff: true },
    );
    const before = cloud.calls.length;
    vi.mocked(ctx.updateDeviceState).mockClear();

    const left = devices.get("vesync_fryer-1_left");
    await left?.onAttributeWrite?.("onOff", "onOff", true);
    await left?.onAttributeWrite?.("onOff", "onTime", 0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(cloud.calls.length).toBe(before);
    expect(ctx.updateDeviceState).not.toHaveBeenCalled();
    await plugin.onShutdown();
  });

  it("sends a switch back made while the first write is still running", async () => {
    const outlet = row("plug-1", "Plug", "WHOGPLUG");
    const { plugin, devices, cloud } = await running([outlet], {
      "plug-1": { enabled: true },
    });
    const plug = devices.get("vesync_plug-1");

    cloud.hold = (path) => path === V2;
    const off = plug?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.advanceTimersByTimeAsync(0);
    cloud.hold = undefined;
    await plug?.onAttributeWrite?.("onOff", "onOff", true);
    cloud.release();
    await off;

    expect(
      cloud
        .v2()
        .filter((c) => c.method === "setSwitch")
        .map((c) => c.data),
    ).toEqual([
      { enabled: false, id: 0 },
      { enabled: true, id: 0 },
    ]);
    await plugin.onShutdown();
  });

  it("keeps a failed write on the value a poll confirmed during the call", async () => {
    const outlet = row("plug-1", "Plug", "WHOGPLUG");
    const { ctx, plugin, devices, cloud } = await running([outlet], {
      "plug-1": { enabled: true },
    });
    cloud.hold = (_path, body) =>
      (body.payload as Json | undefined)?.method === "setSwitch";
    const off = devices
      .get("vesync_plug-1")
      ?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.advanceTimersByTimeAsync(0);
    cloud.status["plug-1"] = { enabled: false };
    await vi.advanceTimersByTimeAsync(60_000);
    vi.mocked(ctx.updateDeviceState).mockClear();

    cloud.dead.add("plug-1");
    cloud.release();
    await off;

    expect(ctx.updateDeviceState).not.toHaveBeenCalled();
    await plugin.onShutdown();
  });

  it("does not push a read sent before a write that answers during it", async () => {
    const outlet = row("plug-1", "Plug", "WHOGPLUG");
    const { ctx, plugin, devices, cloud } = await running([outlet], {
      "plug-1": { enabled: true },
    });
    cloud.hold = (path) => path === V2;
    await vi.advanceTimersByTimeAsync(60_000);
    const off = devices
      .get("vesync_plug-1")
      ?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.advanceTimersByTimeAsync(0);
    cloud.hold = undefined;
    vi.mocked(ctx.updateDeviceState).mockClear();

    // the read answers on first, then the switch goes through
    cloud.held.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    cloud.status["plug-1"] = { enabled: false };
    cloud.release();
    await off;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ctx.updateDeviceState).not.toHaveBeenCalledWith(
      "vesync_plug-1",
      "onOff",
      expect.anything(),
    );
    await plugin.onShutdown();
  });

  it("puts a failed write back on the polled state, not on an earlier request", async () => {
    const outlet = row("plug-1", "Plug", "WHOGPLUG");
    const { ctx, plugin, devices, cloud } = await running([outlet], {
      "plug-1": { enabled: true },
    });
    const plug = devices.get("vesync_plug-1");
    cloud.hold = (path) => path === V2;
    const off = plug?.onAttributeWrite?.("onOff", "onOff", false);
    const on = plug?.onAttributeWrite?.("onOff", "onOff", true);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(ctx.updateDeviceState).mockClear();

    cloud.dead.add("plug-1");
    cloud.release();
    await Promise.all([off, on]);

    expect(ctx.updateDeviceState).not.toHaveBeenCalled();
    await plugin.onShutdown();
  });

  it("reads the device again 2 s after a write whose reply was lost", async () => {
    const outlet = row("plug-1", "Plug", "WHOGPLUG");
    const { ctx, plugin, devices, cloud } = await running([outlet], {
      "plug-1": { enabled: false },
    });
    cloud.fetch.mockImplementationOnce(async () => {
      cloud.status["plug-1"] = { enabled: true };
      throw new TypeError("fetch failed");
    });

    await devices
      .get("vesync_plug-1")
      ?.onAttributeWrite?.("onOff", "onOff", true);
    expect(ctx.updateDeviceState).toHaveBeenLastCalledWith(
      "vesync_plug-1",
      "onOff",
      { onOff: false },
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(ctx.updateDeviceState).toHaveBeenLastCalledWith(
      "vesync_plug-1",
      "onOff",
      { onOff: true },
    );
    await plugin.onShutdown();
  });

  it("leaves nothing behind when a write finishes after shutdown", async () => {
    const { ctx, plugin, devices, cloud } = await running([FRYER], {
      "fryer-1": fryerStatus("cooking"),
    });
    cloud.hold = (path) => path === V2;
    const write = devices
      .get("vesync_fryer-1_left")
      ?.onAttributeWrite?.("onOff", "onOff", false);
    await vi.advanceTimersByTimeAsync(0);
    await plugin.onShutdown();
    vi.mocked(ctx.updateDeviceState).mockClear();

    cloud.release();
    await write;

    expect(ctx.updateDeviceState).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every timer on shutdown and unmounts every unit", async () => {
    const { plugin, devices, cloud } = await running([FRYER, AIR], {
      "fryer-1": fryerStatus("cooking"),
      "air-1": { enabled: true, level: 1, mode: "manual" },
    });
    await devices
      .get("vesync_fryer-1_left")
      ?.onAttributeWrite?.("onOff", "onOff", false);
    expect(vi.getTimerCount()).toBe(2);

    await plugin.onShutdown();

    expect(vi.getTimerCount()).toBe(0);
    expect(devices.size).toBe(0);
    const calls = cloud.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(cloud.calls.length).toBe(calls);
  });
});
