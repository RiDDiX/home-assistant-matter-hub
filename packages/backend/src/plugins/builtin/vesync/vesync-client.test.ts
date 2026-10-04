import { describe, expect, it, vi } from "vitest";
import {
  generateTerminalId,
  VeSyncClient,
  type VeSyncClientOptions,
  type VeSyncDeviceInfo,
  VeSyncError,
} from "./vesync-client.js";

const US = "https://smartapi.vesync.com";
const EU = "https://smartapi.vesync.eu";
const AUTH = "/globalPlatform/api/accountAuth/v1/authByPWDOrOTM";
const LOGIN = "/user/api/accountManage/v1/loginByAuthorizeCode4Vesync";
const DEVICES = "/cloud/v1/deviceManaged/devices";
const V2 = "/cloud/v2/deviceManaged/bypassV2";

const EMAIL = "someone@example.com";
const PASSWORD = "hunter2 secret";
const PASSWORD_MD5 = "436b5bbcb483bed9b123c467e29369a8";
const TERMINAL = "2abcdef0123456789abcdef0123456789";

const FRYER: VeSyncDeviceInfo = {
  cid: "vssk-cid-1",
  uuid: "uuid-1",
  name: "Fryer",
  deviceType: "CAF-P583S-KUS",
  configModule: "WFON_AFR_CAF-P583S-KUS_US",
  online: true,
};

type Json = Record<string, unknown>;
type Answer = (path: string, body: Json, host: string) => unknown;

interface Call {
  host: string;
  path: string;
  body: Json;
  init: RequestInit;
}

const ok = (result: unknown) => ({ code: 0, msg: "request success", result });
const fail = (code: number, result: unknown = null) => ({
  code,
  msg: "error",
  result,
});

function defaultCloud(): Answer {
  let logins = 0;
  return (path, body) => {
    if (path === AUTH) {
      return ok({
        accountID: "1234",
        authorizeCode: "authcode-1",
        bizToken: null,
        mfaMethodList: null,
      });
    }
    if (path === LOGIN) {
      logins++;
      return ok({
        token: `tok-${logins}`,
        accountID: "1234",
        countryCode: body.userCountryCode,
        currentRegion: "US",
        bizToken: null,
      });
    }
    if (path === DEVICES) {
      return ok({ total: 0, pageNo: 1, pageSize: 100, list: [] });
    }
    if (path === V2) {
      return ok({ traceId: "1", code: 0, result: { enabled: true } });
    }
    return ok({ deviceStatus: "on" });
  };
}

function setup(answer?: Answer, options: Partial<VeSyncClientOptions> = {}) {
  const fallback = defaultCloud();
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Json;
    calls.push({
      host: url.origin,
      path: url.pathname,
      body,
      init: init ?? {},
    });
    const out =
      answer?.(url.pathname, body, url.origin) ??
      fallback(url.pathname, body, url.origin);
    return out instanceof Response ? out : Response.json(out);
  };
  const onSession = vi.fn();
  const client = new VeSyncClient({
    email: EMAIL,
    password: PASSWORD,
    terminalId: TERMINAL,
    fetch,
    onSession,
    ...options,
  });
  return { client, calls, onSession };
}

async function failure(promise: Promise<unknown>): Promise<VeSyncError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VeSyncError);
  return err as VeSyncError;
}

const sorted = (keys: string[]) => [...keys].sort();

describe("VeSyncClient login", () => {
  it("sends the two auth steps with the pyvesync key sets", async () => {
    const { client, calls, onSession } = setup();
    const session = await client.login();

    expect(calls.map((c) => [c.host, c.path])).toEqual([
      [US, AUTH],
      [US, LOGIN],
    ]);
    const [step1, step2] = calls;
    expect(sorted(Object.keys(step1.body))).toEqual(
      sorted([
        "email",
        "method",
        "password",
        "acceptLanguage",
        "accountID",
        "authProtocolType",
        "clientInfo",
        "clientType",
        "clientVersion",
        "debugMode",
        "osInfo",
        "terminalId",
        "timeZone",
        "token",
        "userCountryCode",
        "appID",
        "sourceAppID",
        "traceId",
      ]),
    );
    expect(step1.body).toMatchObject({
      email: EMAIL,
      method: "authByPWDOrOTM",
      password: PASSWORD_MD5,
      acceptLanguage: "en",
      accountID: "",
      authProtocolType: "generic",
      clientInfo: "pyvesync",
      clientType: "vesyncApp",
      clientVersion: "VeSync 5.6.60",
      debugMode: false,
      osInfo: "Android",
      terminalId: TERMINAL,
      token: "",
      userCountryCode: "US",
      appID: "eldodkfj",
      sourceAppID: "eldodkfj",
    });
    expect(step1.body.traceId).toMatch(/^APP5678\d{10}-00001$/);

    expect(sorted(Object.keys(step2.body))).toEqual(
      sorted([
        "method",
        "authorizeCode",
        "acceptLanguage",
        "accountID",
        "clientInfo",
        "clientType",
        "clientVersion",
        "debugMode",
        "emailSubscriptions",
        "osInfo",
        "terminalId",
        "timeZone",
        "token",
        "userCountryCode",
        "traceId",
      ]),
    );
    expect(step2.body).toMatchObject({
      method: "loginByAuthorizeCode4Vesync",
      authorizeCode: "authcode-1",
      emailSubscriptions: false,
      userCountryCode: "US",
    });
    expect(step2.body.traceId).toMatch(/-00002$/);

    for (const call of calls) {
      expect(call.init.method).toBe("POST");
      expect(call.init.headers).toEqual({
        "Content-Type": "application/json; charset=UTF-8",
        "User-Agent": "okhttp/3.12.1",
      });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }

    expect(session).toEqual({
      token: "tok-1",
      accountId: "1234",
      countryCode: "US",
      region: "US",
    });
    expect(onSession).toHaveBeenCalledWith(session);
  });

  it("retries only step 2 on the server's region after a cross-region error", async () => {
    let step2 = 0;
    const { client, calls } = setup((path) => {
      if (path === LOGIN && ++step2 === 1) {
        return fail(-11260022, {
          currentRegion: "EU",
          countryCode: "DE",
          token: null,
          bizToken: "biz-1",
        });
      }
      if (path === LOGIN) {
        return ok({ token: "tok-eu", accountID: "1234", countryCode: "DE" });
      }
      return undefined;
    });

    const session = await client.login();
    expect(calls.map((c) => [c.host, c.path])).toEqual([
      [US, AUTH],
      [US, LOGIN],
      [EU, LOGIN],
    ]);
    expect(calls[2].body).toMatchObject({
      authorizeCode: "authcode-1",
      bizToken: "biz-1",
      regionChange: "lastRegion",
      userCountryCode: "DE",
    });
    expect(Object.keys(calls[2].body)).toHaveLength(17);
    expect(session).toEqual({
      token: "tok-eu",
      accountId: "1234",
      countryCode: "DE",
      region: "EU",
    });

    await client.devices();
    expect(calls[3]).toMatchObject({ host: EU, path: DEVICES });
  });

  it("repeats the whole login once on the other host when no bizToken comes back", async () => {
    const { client, calls } = setup((path) =>
      path === LOGIN ? fail(-11261022, { currentRegion: null }) : undefined,
    );

    const err = await failure(client.login());
    expect(calls.map((c) => [c.host, c.path])).toEqual([
      [US, AUTH],
      [US, LOGIN],
      [EU, AUTH],
      [EU, LOGIN],
    ]);
    expect(err.kind).toBe("api");
    expect(err.code).toBe(-11261022);
  });

  it("shares one in-flight login between concurrent calls", async () => {
    const { client, calls } = setup();
    await Promise.all([client.devices(), client.devices(), client.login()]);
    expect(calls.filter((c) => c.path === AUTH)).toHaveLength(1);
    expect(calls.filter((c) => c.path === DEVICES)).toHaveLength(2);
  });

  it.each([
    [-11201129, "credentials"],
    [-11202129, "credentials"],
    [-11000129, "credentials"],
    [-11257129, "mfa"],
  ])("maps step 1 code %i to %s", async (code, kind) => {
    const { client, calls } = setup((path) =>
      path === AUTH ? fail(code) : undefined,
    );
    const err = await failure(client.login());
    expect(err.kind).toBe(kind);
    expect(err.code).toBe(code);
    expect(calls).toHaveLength(1);
  });
});

describe("VeSyncClient session", () => {
  const restored = {
    token: "stale-token",
    accountId: "42",
    countryCode: "DE",
    region: "EU" as const,
  };

  it("uses a restored session without logging in", async () => {
    const { client, calls } = setup(undefined, { session: restored });
    await client.devices();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: EU,
      path: DEVICES,
      body: { token: "stale-token", accountID: "42" },
    });
    expect(await client.login()).toBe(restored);
  });

  it("logs in again on a token error and replays once with the new token", async () => {
    const { client, calls, onSession } = setup(
      (path, body) =>
        path === DEVICES && body.token === "stale-token"
          ? fail(-11001022)
          : undefined,
      { session: restored },
    );

    await client.devices();
    expect(calls.map((c) => [c.host, c.path])).toEqual([
      [EU, DEVICES],
      [EU, AUTH],
      [EU, LOGIN],
      [EU, DEVICES],
    ]);
    expect(calls[1].body.userCountryCode).toBe("DE");
    expect(calls[3].body.token).toBe("tok-1");
    expect(calls[3].body.traceId).not.toBe(calls[0].body.traceId);
    expect(onSession.mock.calls).toEqual([
      [undefined],
      [{ token: "tok-1", accountId: "1234", countryCode: "DE", region: "EU" }],
    ]);
  });

  it.each([401, 419])("treats HTTP %i as a rejected token", async (status) => {
    const { client, calls } = setup(
      (path, body) =>
        path === DEVICES && body.token === "stale-token"
          ? new Response("", { status })
          : undefined,
      { session: restored },
    );

    await client.devices();
    expect(calls.map((c) => c.path)).toEqual([DEVICES, AUTH, LOGIN, DEVICES]);
    expect(calls[3].body.token).toBe("tok-1");
  });

  it("throws a token error when the replay is rejected too", async () => {
    const { client, calls } = setup(
      (path) => (path === DEVICES ? fail(-11001000) : undefined),
      { session: restored },
    );
    const err = await failure(client.devices());
    expect(err.kind).toBe("token");
    expect(calls.map((c) => c.path)).toEqual([DEVICES, AUTH, LOGIN, DEVICES]);
  });
});

describe("VeSyncClient errors", () => {
  it.each([
    [-16906086, "quota"],
    [-11003001, "quota"],
    [-11300027, "offline"],
    [4041004, "offline"],
    [-11012022, "api"],
    [-11201129, "api"],
  ])("maps a device call code %i to %s", async (code, kind) => {
    const { client } = setup((path) =>
      path === DEVICES ? fail(code) : undefined,
    );
    const err = await failure(client.devices());
    expect(err.kind).toBe(kind);
    expect(err.code).toBe(code);
  });

  it("treats HTTP errors, non-JSON bodies and fetch failures as network", async () => {
    const http = setup((path) =>
      path === DEVICES ? new Response("busy", { status: 503 }) : undefined,
    );
    expect((await failure(http.client.devices())).kind).toBe("network");

    const html = setup((path) =>
      path === DEVICES ? new Response("<html>", { status: 200 }) : undefined,
    );
    expect((await failure(html.client.devices())).kind).toBe("network");

    const down = setup((path) => {
      if (path === DEVICES) throw new TypeError("fetch failed");
      return undefined;
    });
    const err = await failure(down.client.devices());
    expect(err.kind).toBe("network");
    expect(err.message).toContain("fetch failed");
  });

  it("never puts credentials or tokens into error messages", async () => {
    const secrets = [
      EMAIL,
      PASSWORD,
      PASSWORD_MD5,
      "authcode-1",
      "biz-1",
      "tok-1",
      "stale-token",
    ];
    const scenarios: Array<[Answer, (c: VeSyncClient) => Promise<unknown>]> = [
      [(p) => (p === AUTH ? fail(-11201129) : undefined), (c) => c.login()],
      [(p) => (p === AUTH ? fail(-11257129) : undefined), (c) => c.login()],
      [
        (p) =>
          p === LOGIN
            ? fail(-11260022, { bizToken: "biz-1", currentRegion: "EU" })
            : undefined,
        (c) => c.login(),
      ],
      [
        (p) => (p === DEVICES ? fail(-11001000) : undefined),
        (c) => c.devices(),
      ],
      [
        (p) => (p === DEVICES ? fail(-16906086) : undefined),
        (c) => c.devices(),
      ],
      [
        (p) => (p === V2 ? ok({ code: -1 }) : undefined),
        (c) => c.bypassV2(FRYER, "getAirfryerStatus"),
      ],
      [
        (p) => (p === V2 ? new Response("x", { status: 500 }) : undefined),
        (c) => c.bypassV2(FRYER, "getAirfryerStatus"),
      ],
    ];
    for (const [answer, run] of scenarios) {
      const { client } = setup(answer);
      const err = await failure(run(client));
      for (const secret of secrets) {
        expect(err.message).not.toContain(secret);
      }
    }
  });
});

describe("VeSyncClient device calls", () => {
  const v2Keys = [
    "acceptLanguage",
    "accountID",
    "appVersion",
    "cid",
    "configModule",
    "debugMode",
    "method",
    "phoneBrand",
    "phoneOS",
    "traceId",
    "timeZone",
    "token",
    "userCountryCode",
    "deviceId",
    "configModel",
    "payload",
  ];

  it("builds the bypassV2 envelope and returns the inner result", async () => {
    const { client, calls } = setup((path) =>
      path === V2
        ? ok({ traceId: "1", code: 0, result: { cookStatus: "ready" } })
        : undefined,
    );
    const result = await client.bypassV2(FRYER, "getAirfryerStatus");

    expect(result).toEqual({ cookStatus: "ready" });
    const call = calls[2];
    expect(call).toMatchObject({ host: US, path: V2 });
    expect(sorted(Object.keys(call.body))).toEqual(sorted(v2Keys));
    expect(call.body).toMatchObject({
      acceptLanguage: "en",
      accountID: "1234",
      appVersion: "5.6.60",
      cid: FRYER.cid,
      deviceId: FRYER.cid,
      configModule: FRYER.configModule,
      configModel: FRYER.configModule,
      debugMode: false,
      method: "bypassV2",
      phoneBrand: "pyvesync",
      phoneOS: "Android",
      token: "tok-1",
      userCountryCode: "US",
    });
    expect(call.body.payload).toEqual({
      method: "getAirfryerStatus",
      source: "APP",
      data: {},
    });
  });

  it("adds subDeviceNo and subDeviceType to the body and the payload", async () => {
    const { client, calls } = setup();
    await client.bypassV2(
      FRYER,
      "endCook",
      { chamber: 1 },
      { subDevice: true },
    );
    const { body } = calls[2];
    expect(sorted(Object.keys(body))).toEqual(
      sorted([...v2Keys, "subDeviceNo", "subDeviceType"]),
    );
    expect(body).toMatchObject({ subDeviceNo: 0, subDeviceType: "" });
    expect(body.payload).toEqual({
      method: "endCook",
      source: "APP",
      data: { chamber: 1 },
      subDeviceNo: 0,
      subDeviceType: "",
    });
  });

  it("throws when the inner result code is not 0", async () => {
    const inner = setup((path) => (path === V2 ? ok({ code: -1 }) : undefined));
    const err = await failure(
      inner.client.bypassV2(FRYER, "getAirfryerMultiStatus"),
    );
    expect(err.kind).toBe("api");
    expect(err.code).toBe(-1);

    const offline = setup((path) =>
      path === V2 ? ok({ code: 11, result: null }) : undefined,
    );
    expect(
      (await failure(offline.client.bypassV2(FRYER, "getAirfryerStatus"))).kind,
    ).toBe("offline");
  });

  it("posts bypass v1 to the endpoint path with uuid and flat extras", async () => {
    const { client, calls } = setup();
    const result = await client.bypassV1(FRYER, "deviceStatus", {
      status: "on",
    });
    expect(result).toEqual({ deviceStatus: "on" });
    const call = calls[2];
    expect(call.path).toBe("/cloud/v1/deviceManaged/deviceStatus");
    expect(sorted(Object.keys(call.body))).toEqual(
      sorted([...v2Keys.filter((k) => k !== "payload"), "uuid", "status"]),
    );
    expect(call.body).toMatchObject({
      method: "deviceStatus",
      uuid: "uuid-1",
      status: "on",
    });
  });

  it("follows device list pages and flattens deviceProp", async () => {
    const row = (i: number) => ({
      cid: `cid-${i}`,
      uuid: `uuid-${i}`,
      deviceName: `Plug ${i}`,
      deviceType: "WHOGPLUG",
      configModule: "WFON_OTL_WHOGPLUG_US",
      connectionStatus: "online",
      subDeviceNo: null,
      deviceProp: null,
    });
    const page2 = [
      {
        cid: null,
        uuid: "uuid-only",
        deviceName: "Hulk",
        deviceType: "LDH-H321S-WUS",
        configModule: "VS_WFON_DHM_LDH-H321S-WUS_US",
        connectionStatus: null,
        deviceProp: { powerSwitch: 1, connectionStatus: "online" },
      },
      {
        cid: null,
        uuid: null,
        macID: "old-mac",
        deviceName: "Mac only",
        deviceType: "ESW03-USA",
        configModule: "ConfigModule",
        connectionStatus: null,
        deviceProp: { connectionStatus: "offline", wifiMac: "aa:bb" },
      },
      {
        cid: "outdoor",
        deviceName: "Outdoor",
        deviceType: "ESO15-TB",
        configModule: "OutdoorSocket15A",
        connectionStatus: "online",
        subDeviceNo: 2,
      },
      { cid: "broken", deviceName: "No type" },
    ];
    const { client, calls } = setup((path, body) => {
      if (path !== DEVICES) return undefined;
      return body.pageNo === 1
        ? ok({
            total: 104,
            pageNo: 1,
            pageSize: 100,
            list: Array.from({ length: 100 }, (_, i) => row(i)),
          })
        : ok({ total: 104, pageNo: 2, pageSize: 100, list: page2 });
    });

    const devices = await client.devices();
    const listCalls = calls.filter((c) => c.path === DEVICES);
    expect(listCalls.map((c) => c.body.pageNo)).toEqual([1, 2]);
    expect(sorted(Object.keys(listCalls[0].body))).toEqual(
      sorted([
        "token",
        "accountID",
        "timeZone",
        "method",
        "pageNo",
        "pageSize",
        "appVersion",
        "phoneBrand",
        "phoneOS",
        "acceptLanguage",
        "traceId",
      ]),
    );
    expect(listCalls[0].body).toMatchObject({
      method: "devices",
      pageSize: 100,
      appVersion: "5.6.60",
      token: "tok-1",
    });

    expect(devices).toHaveLength(103);
    expect(devices[0]).toEqual({
      cid: "cid-0",
      uuid: "uuid-0",
      name: "Plug 0",
      deviceType: "WHOGPLUG",
      configModule: "WFON_OTL_WHOGPLUG_US",
      subDeviceNo: undefined,
      online: true,
    });
    expect(devices.slice(100)).toEqual([
      {
        cid: "uuid-only",
        uuid: "uuid-only",
        name: "Hulk",
        deviceType: "LDH-H321S-WUS",
        configModule: "VS_WFON_DHM_LDH-H321S-WUS_US",
        online: true,
      },
      {
        cid: "aa:bb",
        name: "Mac only",
        deviceType: "ESW03-USA",
        configModule: "ConfigModule",
        online: false,
      },
      {
        cid: "outdoor",
        name: "Outdoor",
        deviceType: "ESO15-TB",
        configModule: "OutdoorSocket15A",
        subDeviceNo: 2,
        online: true,
      },
    ]);
  });
});

describe("generateTerminalId", () => {
  it("returns 2 followed by 32 hex chars", () => {
    expect(generateTerminalId()).toMatch(/^2[0-9a-f]{32}$/);
    expect(generateTerminalId()).not.toBe(generateTerminalId());
  });
});
