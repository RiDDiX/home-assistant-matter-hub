import { createHash } from "node:crypto";
import type {
  MatterHubPlugin,
  PluginConfigSchema,
  PluginContext,
} from "../../types.js";
import {
  generateTerminalId,
  VeSyncClient,
  type VeSyncDeviceInfo,
  VeSyncError,
  type VeSyncSession,
} from "./vesync-client.js";
import {
  familyFor,
  type VeSyncFamily,
  type VeSyncState,
  type VeSyncUnit,
} from "./vesync-devices.js";

interface VeSyncPluginDeps {
  fetch?: typeof fetch;
}

type Attributes = Record<string, unknown>;

// One registered Matter device: a unit of a VeSync device.
interface Mounted {
  id: string;
  key: string;
  device: VeSyncDeviceInfo;
  family: VeSyncFamily;
  unit: VeSyncUnit;
  // what the endpoint holds per cluster, the echo guard compares against it
  pushed: Map<string, Attributes>;
  // last state a poll read or a write confirmed, a failed write goes back to it
  real: Map<string, Attributes>;
  // counts writes, a poll answer older than the last write is not pushed
  writes: number;
}

const CONFIG_KEY = "config";
const SESSION_KEY = "session";
const TERMINAL_KEY = "terminalId";
const DEVICES_KEY = "devices";
// hash of the credentials the session and device list belong to
const ACCOUNT_KEY = "account";

const REACHABLE = "bridgedDeviceBasicInformation";
const LIST_REFRESH_MS = 15 * 60_000;
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 300_000;
const QUOTA_RETRY_MS = 3_600_000;
const EARLY_POLL_MS = 2_000;
// These end the whole cycle. A network error does so only when no device
// could be reached, anything else only fails the one device.
const ACCOUNT_ERRORS = ["credentials", "mfa", "quota", "token"];

// The request quota is per account, every bridge runs its own instance.
const accountLoad = new Map<string, Map<VeSyncPlugin, string[]>>();

const deviceKey = (device: VeSyncDeviceInfo) =>
  (device.subDeviceNo === undefined
    ? device.cid
    : `${device.cid}_${device.subDeviceNo}`
  ).replace(/[^A-Za-z0-9_-]/g, "_");

const same = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// VeSync cloud devices (Levoit, Cosori, Etekcity). Every device is hidden until
// its switch in the config dialog is turned on.
export class VeSyncPlugin implements MatterHubPlugin {
  readonly name = "vesync";
  readonly version = "0.1.0";

  private context?: PluginContext;
  private config: Record<string, unknown> = {};
  private terminalId = "";
  private client?: VeSyncClient;
  private devices: VeSyncDeviceInfo[] = [];
  private mounted = new Map<string, Mounted>();
  private failures = new Map<string, string>();
  private status = "not configured";
  // Bumped on start, config save and shutdown; work from an older
  // generation is dropped after every await.
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private earlyPolls = new Map<string, ReturnType<typeof setTimeout>>();
  private busy = false;
  private again = false;
  private stopped = false;
  private backoffMs = RETRY_BASE_MS;
  private listAt?: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VeSyncPluginDeps = {}) {}

  async onStart(context: PluginContext): Promise<void> {
    this.context = context;
    this.generation++;
    this.mounted = new Map();
    this.config =
      (await context.storage.get<Record<string, unknown>>(CONFIG_KEY)) ?? {};
    // a save while disabled reaches storage without onConfigChanged
    await this.forgetOtherAccount(context);
    const session = await context.storage.get<VeSyncSession>(SESSION_KEY);
    let terminalId = await context.storage.get<string>(TERMINAL_KEY);
    if (!terminalId) {
      terminalId = generateTerminalId();
      await context.storage.set(TERMINAL_KEY, terminalId);
    }
    this.terminalId = terminalId;
    this.devices =
      (await context.storage.get<VeSyncDeviceInfo[]>(DEVICES_KEY)) ?? [];
    this.stopped = false;
    this.backoffMs = RETRY_BASE_MS;
    this.listAt = undefined;
    if (!this.configured()) {
      this.status = "not configured";
      context.log.info("no VeSync account configured, no devices exposed");
      return;
    }
    this.status = "signing in";
    this.client = this.newClient(session);
    await this.reconcile();
    this.schedule(0);
  }

  async onConfigChanged(config: Record<string, unknown>): Promise<void> {
    this.config = config;
    const context = this.context;
    if (!context) return;
    await context.storage.set(CONFIG_KEY, config);
    this.generation++;
    this.clearTimers();
    this.leaveAccountLoad();
    this.stopped = false;
    this.backoffMs = RETRY_BASE_MS;
    this.listAt = undefined;
    if (await this.forgetOtherAccount(context)) this.client = undefined;
    if (this.configured()) {
      this.client ??= this.newClient();
      this.status = "signing in";
    } else {
      this.client = undefined;
      this.status = "not configured";
    }
    await this.reconcile();
    if (this.client) this.schedule(0);
  }

  async onShutdown(): Promise<void> {
    this.generation++;
    this.clearTimers();
    this.leaveAccountLoad();
    this.again = false;
    this.client = undefined;
    await this.reconcile();
  }

  getCurrentConfig(): Record<string, unknown> {
    return { ...this.config };
  }

  getConfigSchema(): PluginConfigSchema {
    const properties: PluginConfigSchema["properties"] = {
      email: {
        type: "string",
        title: "Email",
        description: "The account you use in the VeSync app.",
      },
      password: { type: "string", title: "Password", secret: true },
      pollInterval: {
        type: "number",
        title: "Poll interval (seconds)",
        description:
          "30 to 3600. Raised on its own when many devices would use up the daily VeSync request quota, which every bridge and app on the account shares.",
        default: 60,
      },
    };
    const unsupported: string[] = [];
    for (const device of this.devices) {
      const family = familyFor(device.deviceType);
      if (!family) {
        unsupported.push(`${device.name} (${device.deviceType})`);
        continue;
      }
      properties[`expose_${deviceKey(device)}`] = {
        type: "boolean",
        title: device.name,
        description: `${family.label}, ${device.deviceType}`,
        default: false,
      };
    }
    let description = `Status: ${this.status}.`;
    if (unsupported.length > 0) {
      description += ` Not supported yet: ${unsupported.join(", ")}.`;
    }
    return { title: "VeSync", description, properties };
  }

  private configured(): boolean {
    const { email, password } = this.config;
    return (
      typeof email === "string" &&
      email.trim() !== "" &&
      typeof password === "string" &&
      password !== ""
    );
  }

  // leftover session and list from another account would be reused
  private async forgetOtherAccount(context: PluginContext): Promise<boolean> {
    const { email, password } = this.config;
    const account = createHash("sha256")
      .update(`${String(email ?? "").trim()}\0${String(password ?? "")}`)
      .digest("hex");
    if ((await context.storage.get<string>(ACCOUNT_KEY)) === account) {
      return false;
    }
    this.devices = [];
    await context.storage.delete(SESSION_KEY);
    await context.storage.set(DEVICES_KEY, []);
    await context.storage.set(ACCOUNT_KEY, account);
    return true;
  }

  private leaveAccountLoad(): void {
    for (const [account, load] of accountLoad) {
      load.delete(this);
      if (load.size === 0) accountLoad.delete(account);
    }
  }

  private newClient(session?: VeSyncSession): VeSyncClient {
    const client: VeSyncClient = new VeSyncClient({
      email: String(this.config.email).trim(),
      password: String(this.config.password),
      terminalId: this.terminalId,
      session,
      fetch: this.deps.fetch,
      onSession: (next) => {
        // a client replaced by a credential change must not store its login
        if (this.client !== client) return;
        const storage = this.context?.storage;
        (next
          ? storage?.set(SESSION_KEY, next)
          : storage?.delete(SESSION_KEY)
        )?.catch(() => this.warn("could not store the VeSync session"));
      },
    });
    return client;
  }

  private pollSeconds(): number {
    const seconds = Number(this.config.pollInterval);
    return Number.isFinite(seconds)
      ? Math.min(3600, Math.max(30, seconds))
      : 60;
  }

  private warn(message: string): void {
    this.context?.log.warn(message);
  }

  // Registrations run one at a time, a shutdown queues behind a running one.
  private reconcile(): Promise<void> {
    const run = this.queue.then(() => this.applyExposed());
    this.queue = run.catch(() => {});
    return run;
  }

  private async applyExposed(): Promise<void> {
    const context = this.context;
    if (!context) return;
    const wanted = new Map<
      string,
      Omit<Mounted, "pushed" | "real" | "writes">
    >();
    for (const device of this.client ? this.devices : []) {
      const family = familyFor(device.deviceType);
      const key = deviceKey(device);
      if (!family || this.config[`expose_${key}`] !== true) continue;
      for (const unit of family.units(device)) {
        const id = unit.key ? `vesync_${key}_${unit.key}` : `vesync_${key}`;
        wanted.set(id, { id, key, device, family, unit });
      }
    }
    for (const id of [...this.mounted.keys()]) {
      if (wanted.has(id)) continue;
      this.mounted.delete(id);
      await context.unregisterDevice(id).catch(() => {});
    }
    for (const [id, want] of wanted) {
      const have = this.mounted.get(id);
      if (have) {
        have.device = want.device;
        continue;
      }
      const clusters = want.family.initial(want.device)[want.unit.key] ?? [];
      const initial = clusters.map((c): [string, Attributes] => [
        c.clusterId,
        { ...c.attributes },
      ]);
      const mounted: Mounted = {
        ...want,
        pushed: new Map([[REACHABLE, { reachable: true }], ...initial]),
        real: new Map(initial),
        writes: 0,
      };
      this.mounted.set(id, mounted);
      await context.registerDevice({
        id,
        name: want.unit.label
          ? `${want.device.name} ${want.unit.label}`
          : want.device.name,
        deviceType: want.unit.deviceType,
        // fanModeSequence is mandatory without a default, the endpoint does
        // not mount without it
        clusters: clusters.map((c) =>
          c.clusterId === "fanControl"
            ? { ...c, attributes: { fanModeSequence: 0, ...c.attributes } }
            : c,
        ),
        onAttributeWrite: (clusterId, attribute, value) =>
          this.onWrite(id, clusterId, attribute, value),
      });
    }
    for (const mounted of this.mounted.values()) {
      this.push(mounted, REACHABLE, { reachable: mounted.device.online });
    }
  }

  private push(mounted: Mounted, clusterId: string, attributes: Attributes) {
    const last = mounted.pushed.get(clusterId);
    if (last && Object.entries(attributes).every(([k, v]) => same(last[k], v)))
      return;
    mounted.pushed.set(clusterId, { ...last, ...attributes });
    this.context?.updateDeviceState(mounted.id, clusterId, attributes);
  }

  // Runs after matter.js committed the change, so a refused or failed write
  // can only be undone by pushing the real state back.
  private async onWrite(
    id: string,
    clusterId: string,
    attribute: string,
    value: unknown,
  ): Promise<void> {
    const mounted = this.mounted.get(id);
    const last = mounted?.pushed.get(clusterId);
    // only attributes this plugin pushes are forwarded; equal means echo
    if (!mounted || !last || !(attribute in last)) return;
    if (same(last[attribute], value)) return;
    // recorded up front, so switching back during the call is not an echo
    mounted.pushed.set(clusterId, { ...last, [attribute]: value });
    mounted.writes++;
    const client = this.client;
    let ok = false;
    if (client && !this.stopped) {
      try {
        ok = await mounted.family.write(
          client,
          mounted.device,
          mounted.unit.key,
          clusterId,
          attribute,
          value,
        );
      } catch (e) {
        this.warn(`${mounted.device.name}: write failed: ${errorText(e)}`);
      }
    }
    if (this.mounted.get(id) !== mounted) return;
    // also replaces a poll answer dropped because it overlapped this write,
    // and catches a command taken before its reply was lost
    if (this.client && !this.stopped) this.pollSoon(mounted.key);
    const real = mounted.real.get(clusterId);
    if (ok) {
      mounted.real.set(clusterId, { ...real, [attribute]: value });
      return;
    }
    // a newer write or poll since then already set the endpoint
    const now = mounted.pushed.get(clusterId);
    if (!now || !same(now[attribute], value)) return;
    if (real) this.push(mounted, clusterId, real);
  }

  private pollSoon(key: string): void {
    clearTimeout(this.earlyPolls.get(key));
    const generation = this.generation;
    const timer = setTimeout(() => {
      this.earlyPolls.delete(key);
      this.poll(key, generation).catch((e) =>
        this.warn(`status read failed: ${errorText(e)}`),
      );
    }, EARLY_POLL_MS);
    timer.unref?.();
    this.earlyPolls.set(key, timer);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.cycle();
    }, delayMs);
    this.timer.unref?.();
  }

  private clearTimers(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const timer of this.earlyPolls.values()) clearTimeout(timer);
    this.earlyPolls.clear();
  }

  // Single flight: a kick during a running cycle runs once it is done.
  private async cycle(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.again = false;
    const generation = this.generation;
    let next: number | undefined;
    try {
      next = await this.step(generation);
    } catch (e) {
      if (generation === this.generation) next = this.failed(e);
    } finally {
      this.busy = false;
    }
    if (this.again) this.schedule(0);
    else if (next !== undefined && generation === this.generation)
      this.schedule(next);
  }

  private async step(generation: number): Promise<number | undefined> {
    const client = this.client;
    const context = this.context;
    if (!client || !context) return undefined;
    await client.login();
    if (generation !== this.generation) return undefined;
    const now = Date.now();
    if (this.listAt === undefined || now - this.listAt >= LIST_REFRESH_MS) {
      const devices = await client.devices();
      if (generation !== this.generation) return undefined;
      this.devices = devices;
      this.listAt = now;
      await context.storage.set(DEVICES_KEY, devices);
      await this.reconcile();
      if (generation !== this.generation) return undefined;
    }
    const n = this.devices.length;
    this.status = `signed in, ${n} device${n === 1 ? "" : "s"} found`;
    const keys = [...new Set([...this.mounted.values()].map((m) => m.key))];
    let lost: unknown;
    let reached = keys.length === 0;
    for (const key of keys) {
      const error = await this.poll(key, generation);
      if (generation !== this.generation) return undefined;
      if (error) lost ??= error;
      else reached = true;
    }
    if (!reached) throw lost;
    this.backoffMs = RETRY_BASE_MS;
    const account = String(this.config.email).trim().toLowerCase();
    const load = accountLoad.get(account) ?? new Map<VeSyncPlugin, string[]>();
    load.set(this, keys);
    accountLoad.set(account, load);
    const polled = [...load.values()];
    const total = polled.reduce((sum, k) => sum + k.length, 0);
    const owned = new Set(polled.flat()).size;
    // stay under 80 % of the daily quota of 3200 + 1500 per device
    const floor = Math.ceil((86400 * total) / (0.8 * (3200 + 1500 * owned)));
    return Math.max(this.pollSeconds(), floor) * 1000;
  }

  private failed(e: unknown): number | undefined {
    this.warn(errorText(e));
    const kind = e instanceof VeSyncError ? e.kind : undefined;
    if (kind === "credentials" || kind === "mfa") {
      this.stopped = true;
      // nothing reads them again, their state would be made up
      for (const m of this.mounted.values()) {
        this.push(m, REACHABLE, { reachable: false });
      }
      this.status =
        kind === "mfa"
          ? "this account uses two-factor sign-in, which is not supported"
          : "sign-in failed: wrong email or password";
      return undefined;
    }
    if (kind === "quota") {
      this.status = "daily request quota used up, retrying later";
      return QUOTA_RETRY_MS;
    }
    this.status = "cloud unreachable, retrying";
    const delay = this.backoffMs;
    this.backoffMs = Math.min(delay * 2, RETRY_MAX_MS);
    return delay;
  }

  // network comes back so the cycle can fail when every device is unreachable
  private async poll(key: string, generation: number): Promise<unknown> {
    const units = [...this.mounted.values()].filter((m) => m.key === key);
    const client = this.client;
    if (generation !== this.generation || this.stopped) return;
    if (units.length === 0 || !client) return;
    const { device, family } = units[0];
    const writes = units.map((m) => m.writes);
    let state: VeSyncState;
    try {
      state = await family.read(client, device);
    } catch (e) {
      if (generation !== this.generation) return;
      const kind = e instanceof VeSyncError ? e.kind : undefined;
      if (kind && ACCOUNT_ERRORS.includes(kind)) throw e;
      if (kind === "offline") {
        for (const m of units) this.push(m, REACHABLE, { reachable: false });
        return;
      }
      const message = errorText(e);
      if (this.failures.get(key) !== message) {
        this.warn(`${device.name}: status read failed: ${message}`);
      }
      this.failures.set(key, message);
      return kind === "network" ? e : undefined;
    }
    if (generation !== this.generation) return;
    this.failures.delete(key);
    for (const [i, m] of units.entries()) {
      if (this.mounted.get(m.id) !== m) continue;
      const fresh = m.writes === writes[i];
      for (const c of fresh ? (state[m.unit.key] ?? []) : []) {
        m.real.set(c.clusterId, {
          ...m.real.get(c.clusterId),
          ...c.attributes,
        });
        this.push(m, c.clusterId, c.attributes);
      }
      this.push(m, REACHABLE, { reachable: true });
    }
  }
}
