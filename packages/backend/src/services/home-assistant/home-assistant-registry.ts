import { createHash } from "node:crypto";
import type {
  HomeAssistantDeviceRegistry,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { HassEntity } from "home-assistant-js-websocket";
import { fromPairs, keyBy, keys, uniq, values } from "lodash-es";
import { Service } from "../../core/ioc/service.js";
import { logMemoryUsage } from "../../utils/log-memory.js";
import { withRetry } from "../../utils/retry.js";
import { sendHaMessage } from "../../utils/send-ha-message.js";
import {
  getAreaRegistry,
  getDeviceRegistry,
  getLabelRegistry,
  getRegistry,
  type HomeAssistantLabel,
} from "./api/get-registry.js";
import type {
  HomeAssistantClient,
  HomeAssistantClientProps,
} from "./home-assistant-client.js";

const logger = Logger.get("HomeAssistantRegistry");
// shortcut: groups still incomplete after 60s use auto-refresh; revisit if controllers still rediscover devices.
const STARTUP_WAIT_MS = 60_000;
const INCOMPLETE_REFRESH_RETRIES = 3;

export type HomeAssistantDevices = Record<string, HomeAssistantDeviceRegistry>;
export type HomeAssistantEntities = Record<string, HomeAssistantEntityRegistry>;
export type HomeAssistantStates = Record<string, HomeAssistantEntityState>;
export type HomeAssistantLabels = HomeAssistantLabel[];
export type HomeAssistantAreas = Map<string, string>;

export class HomeAssistantRegistry extends Service {
  private autoRefresh?: NodeJS.Timeout;
  private refreshPending = false;
  private refreshRetries = 0;
  // Set with every new fingerprint, so a change found by an outside reload()
  // still reaches the bridges on the next tick.
  private registryChanged = false;
  private lastRegistryFingerprint = "";

  // Bumped on every successful reload, even an unchanged one. Endpoint
  // removal requires a bump between stamp and delete, so a stale cached
  // snapshot can never confirm a removal (#438).
  private _snapshotGeneration = 0;
  get snapshotGeneration() {
    return this._snapshotGeneration;
  }

  // Last HA uptime stamp the auto-refresh saw, so a restart between ticks
  // still drives one reconcile (#438).
  private lastRunningSince = 0;

  private _devices: HomeAssistantDevices = {};
  get devices() {
    return this._devices;
  }

  private _entities: HomeAssistantEntities = {};
  get entities() {
    return this._entities;
  }

  private _states: HomeAssistantStates = {};
  get states() {
    return this._states;
  }

  private _labels: HomeAssistantLabels = [];
  get labels() {
    return this._labels;
  }

  private _areas: HomeAssistantAreas = new Map();
  get areas() {
    return this._areas;
  }

  constructor(
    private readonly client: HomeAssistantClient,
    private readonly options: HomeAssistantClientProps,
  ) {
    super("HomeAssistantRegistry");
  }

  protected override async initialize(): Promise<void> {
    try {
      await this.reload();
      // A snapshot fetched while HA was starting is dropped, bridges started on
      // it would go online with no devices (#543). HA can also report RUNNING
      // before group sensors inherit their members' classes. The deadline is
      // checked between reloads, each reload has its own retry bound.
      const deadline = Date.now() + STARTUP_WAIT_MS;
      if (this._snapshotGeneration === 0) {
        logger.info(
          "Waiting for Home Assistant to finish starting before starting bridges",
        );
      }
      let pending = this.pendingGroupSensors();
      let groupsLogged = false;
      while (
        (this._snapshotGeneration === 0 || pending.length > 0) &&
        Date.now() < deadline
      ) {
        if (pending.length > 0 && !groupsLogged) {
          groupsLogged = true;
          logger.info(
            "Waiting for group sensor attributes before starting bridges",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          await this.reload();
        } catch (e) {
          logger.debug("Startup registry reload failed, retrying:", e);
        }
        pending = this.pendingGroupSensors();
      }
      if (this._snapshotGeneration === 0) {
        logger.warn(
          "Home Assistant still starting after the startup wait, continuing with auto-refresh",
        );
      }
      if (pending.length > 0) {
        logger.warn(
          `Group sensors still initializing after the startup wait, continuing with auto-refresh: ${pending.join(", ")}`,
        );
      }
    } catch (e) {
      // HA's WS endpoint can drop in-flight queries during HA's own startup,
      // and after maxAttempts withRetry gives up. Keep any cached snapshot;
      // enableAutoRefresh keeps trying every tick.
      logger.warn("Initial registry fetch failed, relying on auto-refresh:", e);
    }
  }

  private pendingGroupSensors(): string[] {
    return Object.values(this._entities)
      .filter((entity) => {
        const state = this._states[entity.entity_id];
        return (
          entity.disabled_by == null &&
          entity.platform === "group" &&
          entity.entity_id.startsWith("sensor.") &&
          !state?.attributes.device_class &&
          (!state || state.state === "unknown" || state.state === "unavailable")
        );
      })
      .map((entity) => entity.entity_id);
  }

  override async dispose(): Promise<void> {
    this.disableAutoRefresh();
  }

  enableAutoRefresh(
    onRefresh: () => Promise<boolean | undefined> | boolean | undefined,
  ) {
    this.disableAutoRefresh();

    let refreshing = false;
    this.refreshRetries = 0;
    this.refreshPending = false;
    this.autoRefresh = setInterval(async () => {
      if (refreshing) {
        // Previous tick is still mid-retry (HA slow / reconnecting).
        // Skip this tick so reloads don't stack and overwrite each other.
        logger.debug("Skipping registry refresh, previous tick still running");
        return;
      }
      refreshing = true;
      try {
        // Bridges skip reconciling while HA is down, and a short outage
        // between two ticks can leave the registry structurally unchanged.
        // Compare HA's uptime stamp so that restart still drives one
        // refresh (#438).
        const runningSince = this.client.runningSince;
        const restarted = runningSince !== this.lastRunningSince;
        const changed = (await this.reload()) || this.registryChanged;
        // stamp only now: a reload that failed must not consume the restart
        this.lastRunningSince = runningSince;
        if (changed || restarted) {
          this.refreshRetries = 0;
        } else if (
          !this.refreshPending ||
          this.refreshRetries >= INCOMPLETE_REFRESH_RETRIES
        ) {
          return;
        } else {
          this.refreshRetries++;
        }
        // cleared before the run, a late refresh may mark it during the run
        this.refreshPending = false;
        this.registryChanged = false;
        try {
          if ((await onRefresh()) === false) this.refreshPending = true;
        } catch (e) {
          logger.warn("Bridge refresh failed:", e);
          this.refreshPending = true;
        }
        if (
          this.refreshPending &&
          this.refreshRetries === INCOMPLETE_REFRESH_RETRIES
        ) {
          logger.warn(
            "Bridge refresh still incomplete, waiting for the next registry change",
          );
        }
      } catch (e) {
        logger.warn("Failed to refresh registry, will retry next interval:", e);
      } finally {
        refreshing = false;
      }
    }, this.options.refreshInterval * 1000);
  }

  // Every device refresh that ends incomplete calls this, also one finishing
  // after its tick. Arms the retry without resetting its count, only a
  // registry change or grantRefreshRetries does that.
  markRefreshIncomplete() {
    this.refreshPending = true;
  }

  // A start, update or API refresh that ended incomplete gets a fresh retry
  // budget. Ticks and internal rechecks never call this, so the cap holds.
  grantRefreshRetries() {
    this.refreshPending = true;
    this.refreshRetries = 0;
  }

  disableAutoRefresh() {
    if (this.autoRefresh != null) {
      clearInterval(this.autoRefresh);
    }
    this.autoRefresh = undefined;
  }

  async reload(): Promise<boolean> {
    return await withRetry(() => this.fetchRegistries(), {
      maxAttempts: 10,
      baseDelayMs: 2000,
      maxDelayMs: 30000,
      onRetry: (attempt, error, delayMs) => {
        logger.warn(
          `Registry fetch failed (attempt ${attempt}), retrying in ${delayMs}ms:`,
          error,
        );
      },
    });
  }

  private async fetchRegistries(): Promise<boolean> {
    await this.waitForConnection(30_000);
    try {
      return await this.runRegistryQueries();
    } catch (e) {
      if (!isConnectionLost(e)) throw e;
      // WS dropped mid-flight; the library auto-reconnects. Wait for the
      // next 'ready' and try once more before this attempt is consumed
      // by withRetry's backoff.
      logger.debug("Registry fetch hit connection drop, waiting for reconnect");
      await this.waitForConnection(60_000);
      return await this.runRegistryQueries();
    }
  }

  private async waitForConnection(timeoutMs: number): Promise<void> {
    const connection = this.client.connection;
    if (connection.connected) return;
    logger.debug("Connection not ready, waiting for reconnect...");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        connection.removeEventListener("ready", onReady);
        resolve();
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timeout);
        connection.removeEventListener("ready", onReady);
        resolve();
      };
      connection.addEventListener("ready", onReady);
      if (connection.connected) {
        clearTimeout(timeout);
        connection.removeEventListener("ready", onReady);
        resolve();
      }
    });
  }

  private async runRegistryQueries(): Promise<boolean> {
    // Trust must hold for the WHOLE fetch: a flip to RUNNING mid-flight
    // would otherwise let a STARTING-era partial snapshot commit (#438).
    const trustedAtStart = this.client.haRunning;
    const connection = this.client.connection;

    // Fire the five HA queries in parallel. Label and area registries aren't
    // guaranteed on older HA versions, so a failure there never fails the
    // whole reload.
    const timeoutMs = this.options.messageTimeoutMs;
    const [entityRegistry, statesList, deviceRegistry, labels, areas] =
      await Promise.all([
        getRegistry(connection, timeoutMs),
        sendHaMessage<HassEntity[]>(
          connection,
          { type: "get_states" },
          timeoutMs,
        ),
        getDeviceRegistry(connection, timeoutMs),
        // failed query: keep last labels, empty would unmount filtered
        // endpoints (#500)
        getLabelRegistry(connection, timeoutMs).catch((e) => {
          logger.warn("Label registry fetch failed, keeping last labels:", e);
          return this._labels;
        }),
        // same for areas: empty flips the fingerprint and drops room names
        getAreaRegistry(connection, timeoutMs).catch((e) => {
          logger.warn("Area registry fetch failed, keeping last areas:", e);
          return Array.from(this._areas, ([area_id, name]) => ({
            area_id,
            name,
          }));
        }),
      ]);

    // Fingerprint structural registry data to detect changes.
    // State *values* change constantly (handled by WebSocket subscription);
    // we only check if entity/device/state IDs or key attributes changed.
    const hash = createHash("md5");
    for (const e of entityRegistry) {
      hash.update(
        `${e.entity_id}\0${e.unique_id ?? ""}\0${e.device_id ?? ""}\0${e.disabled_by ?? ""}\0${e.hidden_by ?? ""}\0${e.area_id ?? ""}\0${(e.labels ?? []).join(",")}\0${e.platform ?? ""}\0${e.entity_category ?? ""}\0${e.name ?? ""}\0${e.original_name ?? ""}\n`,
      );
    }
    for (const s of statesList) {
      hash.update(`${s.entity_id}\0${s.attributes?.device_class ?? ""}\n`);
    }
    for (const d of deviceRegistry) {
      hash.update(
        `${d.id}\0${(d.labels ?? []).join(",")}\0${d.area_id ?? ""}\0${d.name_by_user ?? ""}\0${d.name ?? ""}\0${d.model ?? ""}\0${d.model_id ?? ""}\0${d.manufacturer ?? ""}\0${d.hw_version ?? ""}\0${d.sw_version ?? ""}\0${d.serial_number ?? ""}\0${d.default_name ?? ""}\0${d.default_model ?? ""}\0${d.default_manufacturer ?? ""}\n`,
      );
    }
    // name too: matchers resolve label names to ids, a rename must refresh
    for (const l of labels) hash.update(`${l.label_id}\0${l.name}\n`);
    for (const a of areas) hash.update(`${a.area_id}\0${a.name}\n`);
    const fingerprint = hash.digest("hex");

    // A snapshot taken while HA was starting is partial. Publishing it would
    // leave entities missing from the cached registry long after HA is back,
    // and a later removal would confirm against that stale data (#438). Drop
    // the whole fetch instead and keep the last good one.
    if (!trustedAtStart || !this.client.haRunning) {
      logger.debug("Discarding registry snapshot, HA was not running");
      // Forget the fingerprint so the first trusted fetch always counts as
      // changed. Bridges skip reconciling while HA is down, so they need that
      // one refresh even when HA comes back with the same registry (#438).
      this.lastRegistryFingerprint = "";
      return false;
    }
    this._snapshotGeneration++;

    // Always update states (values change via WebSocket, but fresh data
    // is needed for the UI and initial endpoint state)
    // Subscription events merged into the old map while the fetch was in
    // flight, keep those over the older snapshot.
    const states: HomeAssistantStates = keyBy(statesList, "entity_id");
    for (const [id, current] of Object.entries(this._states)) {
      const fetched = states[id];
      if (fetched && current.last_updated > fetched.last_updated) {
        states[id] = current;
      }
    }
    this._states = states;

    if (fingerprint === this.lastRegistryFingerprint) {
      logger.debug("Registry unchanged, skipping full refresh");
      return false;
    }

    // Structure changed, full rebuild
    entityRegistry.forEach((e) => {
      e.device_id = e.device_id ?? mockDeviceId(e.entity_id);
    });
    const entities = keyBy(entityRegistry, "entity_id");

    const entityIds = uniq(keys(entities).concat(keys(this._states)));
    const allEntities = keyBy(
      entityIds.map((id) => entities[id] ?? { entity_id: id, device_id: id }),
      "entity_id",
    );
    const deviceIdsList = values(allEntities).map(
      (e) => e.device_id ?? e.entity_id,
    );

    const realDevices = keyBy(deviceRegistry, "id");
    const missingDeviceIds = uniq(deviceIdsList.filter((d) => !realDevices[d]));
    const missingDevices: Record<string, HomeAssistantDeviceRegistry> =
      fromPairs(missingDeviceIds.map((d) => [d, { id: d }]));

    this._devices = { ...missingDevices, ...realDevices };
    // Use allEntities to include state-only entities (e.g., YAML scripts)
    // that don't have entity registry entries but still need to be filterable
    this._entities = allEntities;

    logger.debug(
      `Loaded HA registry: ${keys(allEntities).length} entities, ${keys(realDevices).length} devices, ${keys(this._states).length} states`,
    );
    logMemoryUsage(logger, "after HA registry load");

    this._labels = labels;
    this._areas = new Map(areas.map((a) => [a.area_id, a.name]));
    // only now: a rebuild that threw must not read as unchanged next time
    this.lastRegistryFingerprint = fingerprint;
    this.registryChanged = true;

    return true;
  }
}

function isConnectionLost(e: unknown): boolean {
  if (e instanceof Error && e.message.includes("Connection lost")) return true;
  const inner = (e as { error?: { code?: number; message?: string } } | null)
    ?.error;
  return inner?.code === 3 || inner?.message === "Connection lost";
}

function mockDeviceId(entityId: string) {
  const hash = createHash("sha256")
    .update(entityId)
    .digest("hex")
    .substring(0, 29);
  return `e__${hash}`;
}
