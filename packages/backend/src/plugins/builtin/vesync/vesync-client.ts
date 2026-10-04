import { createHash, randomUUID } from "node:crypto";

const APP_VERSION = "5.6.60";
const CLIENT_VERSION = `VeSync ${APP_VERSION}`;
const PHONE_BRAND = "pyvesync";
const PHONE_OS = "Android";
const APP_ID = "eldodkfj";
const CLIENT_TYPE = "vesyncApp";
const LANGUAGE = "en";
const HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "User-Agent": "okhttp/3.12.1",
};
const HOSTS = {
  US: "https://smartapi.vesync.com",
  EU: "https://smartapi.vesync.eu",
};
const US_COUNTRIES = ["US", "CA", "MX", "JP"];
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;

const AUTH_PATH = "/globalPlatform/api/accountAuth/v1/authByPWDOrOTM";
const LOGIN_PATH = "/user/api/accountManage/v1/loginByAuthorizeCode4Vesync";
const DEVICES_PATH = "/cloud/v1/deviceManaged/devices";
const V1_PATH = "/cloud/v1/deviceManaged/";
const V2_PATH = "/cloud/v2/deviceManaged/bypassV2";

const CROSS_REGION_CODES = [-11260022, -11261022];
const MFA_CODE = -11257129;
const OFFLINE_CODES = [11, 4041004];
const OFFLINE_GROUPS = [-11300000, -11302000];
const QUOTA_GROUPS = [-16906000, -11003000];
const CREDENTIAL_GROUPS = [-11201000, -11202000, -11200000, -11000000];
const TOKEN_STATUSES = [401, 419];

export type VeSyncErrorKind =
  | "credentials"
  | "mfa"
  | "quota"
  | "token"
  | "offline"
  | "network"
  | "api";

const DESCRIPTIONS: Record<VeSyncErrorKind, string> = {
  credentials: "wrong email or password",
  mfa: "two-factor sign-in is not supported",
  quota: "daily request quota used up",
  token: "session token rejected",
  offline: "device offline",
  network: "cloud unreachable",
  api: "request failed",
};

export class VeSyncError extends Error {
  constructor(
    readonly kind: VeSyncErrorKind,
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "VeSyncError";
  }
}

export interface VeSyncSession {
  token: string;
  accountId: string;
  countryCode: string;
  region: "US" | "EU";
}

type Region = VeSyncSession["region"];

export interface VeSyncDeviceInfo {
  cid: string;
  uuid?: string;
  name: string;
  deviceType: string;
  configModule: string;
  subDeviceNo?: number;
  online: boolean;
}

export interface VeSyncClientOptions {
  email: string;
  password: string;
  terminalId: string;
  session?: VeSyncSession;
  fetch?: typeof fetch;
  onSession?: (session: VeSyncSession | undefined) => void;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Same lookup as pyvesync: exact codes first, then rounded toward zero to 1000.
function errorFor(raw: unknown, op: string, login: boolean): VeSyncError {
  const code = Number(raw);
  if (!Number.isFinite(code)) {
    return new VeSyncError("api", `VeSync ${op}: ${DESCRIPTIONS.api}`);
  }
  const group = Math.trunc(code / 1000) * 1000;
  let kind: VeSyncErrorKind = "api";
  if (code === MFA_CODE) kind = "mfa";
  else if (OFFLINE_CODES.includes(code) || OFFLINE_GROUPS.includes(group))
    kind = "offline";
  else if (group === -11001000) kind = "token";
  else if (QUOTA_GROUPS.includes(group)) kind = "quota";
  else if (login && CREDENTIAL_GROUPS.includes(group)) kind = "credentials";
  return new VeSyncError(
    kind,
    `VeSync ${op}: ${DESCRIPTIONS[kind]} (code ${code})`,
    code,
  );
}

function networkError(op: string, reason: string): VeSyncError {
  return new VeSyncError(
    "network",
    `VeSync ${op}: ${DESCRIPTIONS.network} (${reason})`,
  );
}

function toDevice(row: Json): VeSyncDeviceInfo | undefined {
  const prop = obj(row.deviceProp);
  const cid =
    str(row.cid) ?? str(row.uuid) ?? str(prop.wifiMac) ?? str(row.macID);
  const deviceType = str(row.deviceType);
  if (!cid || !deviceType) return undefined;
  return {
    cid,
    uuid: str(row.uuid),
    name: str(row.deviceName) ?? deviceType,
    deviceType,
    configModule: str(row.configModule) ?? "",
    subDeviceNo:
      typeof row.subDeviceNo === "number" ? row.subDeviceNo : undefined,
    online: (row.connectionStatus ?? prop.connectionStatus) === "online",
  };
}

export function generateTerminalId(): string {
  return `2${randomUUID().replaceAll("-", "")}`;
}

export class VeSyncClient {
  readonly #email: string;
  readonly #passwordHash: string;
  readonly #terminalId: string;
  readonly #fetch?: typeof fetch;
  readonly #onSession?: (session: VeSyncSession | undefined) => void;
  #session?: VeSyncSession;
  #region: Region;
  #countryCode: string;
  #pendingLogin?: Promise<VeSyncSession>;
  #calls = 0;

  constructor(options: VeSyncClientOptions) {
    this.#email = options.email;
    this.#passwordHash = createHash("md5")
      .update(options.password, "utf8")
      .digest("hex");
    this.#terminalId = options.terminalId;
    this.#fetch = options.fetch;
    this.#onSession = options.onSession;
    this.#session = options.session;
    this.#region = options.session?.region ?? "US";
    this.#countryCode = options.session?.countryCode ?? "US";
  }

  // concurrent callers share one sign-in
  login(): Promise<VeSyncSession> {
    if (this.#session) return Promise.resolve(this.#session);
    this.#pendingLogin ??= this.#signIn().finally(() => {
      this.#pendingLogin = undefined;
    });
    return this.#pendingLogin;
  }

  async devices(): Promise<VeSyncDeviceInfo[]> {
    const devices: VeSyncDeviceInfo[] = [];
    for (let pageNo = 1; ; pageNo++) {
      const result = await this.#request("devices", DEVICES_PATH, (s) => ({
        token: s.token,
        accountID: s.accountId,
        timeZone: TIME_ZONE,
        method: "devices",
        pageNo,
        pageSize: PAGE_SIZE,
        appVersion: APP_VERSION,
        phoneBrand: PHONE_BRAND,
        phoneOS: PHONE_OS,
        acceptLanguage: LANGUAGE,
        traceId: this.#traceId(),
      }));
      const list = Array.isArray(result.list) ? result.list : [];
      for (const row of list) {
        const device = toDevice(obj(row));
        if (device) devices.push(device);
      }
      const total = Number(result.total) || 0;
      if (list.length === 0 || pageNo * PAGE_SIZE >= total) return devices;
    }
  }

  async bypassV2(
    device: VeSyncDeviceInfo,
    method: string,
    data: Record<string, unknown> = {},
    options: { subDevice?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const op = `bypassV2 ${method}`;
    const sub = options.subDevice ? { subDeviceNo: 0, subDeviceType: "" } : {};
    const outer = await this.#request(op, V2_PATH, (s) => ({
      ...this.#deviceBody(s, device, "bypassV2"),
      ...sub,
      payload: { method, source: "APP", data, ...sub },
    }));
    // envelope already passed; bypassV2 nests another code in result
    if (outer.code !== 0) throw errorFor(outer.code, op, false);
    return obj(outer.result);
  }

  bypassV1(
    device: VeSyncDeviceInfo,
    endpoint: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.#request(endpoint, V1_PATH + endpoint, (s) => ({
      ...this.#deviceBody(s, device, endpoint),
      uuid: device.uuid,
      ...extra,
    }));
  }

  async #signIn(): Promise<VeSyncSession> {
    let region = this.#region;
    let countryCode = this.#countryCode;
    for (let attempt = 0; ; attempt++) {
      const auth = await this.#post(
        region,
        AUTH_PATH,
        "login",
        this.#authBody(countryCode),
      );
      const authorizeCode = str(obj(auth.result).authorizeCode);
      if (auth.code !== 0 || !authorizeCode) {
        if (attempt === 0 && CROSS_REGION_CODES.includes(Number(auth.code))) {
          region = region === "US" ? "EU" : "US";
          continue;
        }
        throw errorFor(auth.code, "login", true);
      }
      let res = await this.#post(
        region,
        LOGIN_PATH,
        "login",
        this.#loginBody(authorizeCode, countryCode),
      );
      if (attempt === 0 && CROSS_REGION_CODES.includes(Number(res.code))) {
        const cross = obj(res.result);
        countryCode = str(cross.countryCode) ?? countryCode;
        const bizToken = str(cross.bizToken);
        if (!bizToken) {
          region = region === "US" ? "EU" : "US";
          continue;
        }
        region =
          cross.currentRegion === "US" || cross.currentRegion === "EU"
            ? cross.currentRegion
            : US_COUNTRIES.includes(countryCode.toUpperCase())
              ? "US"
              : "EU";
        res = await this.#post(
          region,
          LOGIN_PATH,
          "login",
          this.#loginBody(authorizeCode, countryCode, bizToken),
        );
      }
      const result = obj(res.result);
      const token = str(result.token);
      if (res.code !== 0 || !token || result.accountID == null) {
        throw errorFor(res.code, "login", true);
      }
      const session: VeSyncSession = {
        token,
        accountId: String(result.accountID),
        countryCode: str(result.countryCode) ?? countryCode,
        region,
      };
      this.#session = session;
      this.#region = region;
      this.#countryCode = session.countryCode;
      this.#onSession?.(session);
      return session;
    }
  }

  // a rejected token is dropped here and login() runs once more
  async #request(
    op: string,
    path: string,
    body: (session: VeSyncSession) => object,
  ): Promise<Json> {
    const run = async (session: VeSyncSession) => {
      const res = await this.#post(session.region, path, op, body(session));
      if (res.code !== 0) throw errorFor(res.code, op, false);
      return obj(res.result);
    };
    const session = await this.login();
    try {
      return await run(session);
    } catch (err) {
      if (!(err instanceof VeSyncError && err.kind === "token")) throw err;
    }
    if (this.#session === session) {
      this.#session = undefined;
      this.#onSession?.(undefined);
    }
    return run(await this.login());
  }

  async #post(
    region: Region,
    path: string,
    op: string,
    body: object,
  ): Promise<Json> {
    let res: Response;
    try {
      res = await (this.#fetch ?? fetch)(HOSTS[region] + path, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(op, err instanceof Error ? err.message : String(err));
    }
    if (TOKEN_STATUSES.includes(res.status)) {
      throw new VeSyncError(
        "token",
        `VeSync ${op}: ${DESCRIPTIONS.token} (HTTP ${res.status})`,
      );
    }
    if (res.status >= 400) throw networkError(op, `HTTP ${res.status}`);
    const json: unknown = await res.json().catch(() => undefined);
    if (typeof json !== "object" || json === null) {
      throw networkError(op, "invalid response");
    }
    return json as Json;
  }

  #deviceBody(
    session: VeSyncSession,
    device: VeSyncDeviceInfo,
    method: string,
  ) {
    return {
      acceptLanguage: LANGUAGE,
      accountID: session.accountId,
      appVersion: APP_VERSION,
      cid: device.cid,
      configModule: device.configModule,
      debugMode: false,
      method,
      phoneBrand: PHONE_BRAND,
      phoneOS: PHONE_OS,
      traceId: this.#traceId(),
      timeZone: TIME_ZONE,
      token: session.token,
      userCountryCode: session.countryCode,
      deviceId: device.cid,
      configModel: device.configModule,
    };
  }

  #authBody(countryCode: string) {
    return {
      email: this.#email,
      method: "authByPWDOrOTM",
      password: this.#passwordHash,
      acceptLanguage: LANGUAGE,
      accountID: "",
      authProtocolType: "generic",
      clientInfo: PHONE_BRAND,
      clientType: CLIENT_TYPE,
      clientVersion: CLIENT_VERSION,
      debugMode: false,
      osInfo: PHONE_OS,
      terminalId: this.#terminalId,
      timeZone: TIME_ZONE,
      token: "",
      userCountryCode: countryCode,
      appID: APP_ID,
      sourceAppID: APP_ID,
      traceId: this.#traceId(),
    };
  }

  #loginBody(authorizeCode: string, countryCode: string, bizToken?: string) {
    return {
      method: "loginByAuthorizeCode4Vesync",
      authorizeCode,
      acceptLanguage: LANGUAGE,
      accountID: "",
      clientInfo: PHONE_BRAND,
      clientType: CLIENT_TYPE,
      clientVersion: CLIENT_VERSION,
      debugMode: false,
      emailSubscriptions: false,
      osInfo: PHONE_OS,
      terminalId: this.#terminalId,
      timeZone: TIME_ZONE,
      token: "",
      ...(bizToken ? { bizToken, regionChange: "lastRegion" } : {}),
      userCountryCode: countryCode,
      traceId: this.#traceId(),
    };
  }

  #traceId(): string {
    this.#calls++;
    const seconds = Math.floor(Date.now() / 1000);
    return `APP${this.#terminalId.slice(-5, -1)}${seconds}-${String(this.#calls).padStart(5, "0")}`;
  }
}
