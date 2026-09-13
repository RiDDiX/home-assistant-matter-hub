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

export type HomeAssistantDevices = Record<string, HomeAssistantDeviceRegistry>;
export type HomeAssistantEntities = Record<string, HomeAssistantEntityRegistry>;
export type HomeAssistantStates = Record<string, HomeAssistantEntityState>;
export type HomeAssistantLabels = HomeAssistantLabel[];
export type HomeAssistantAreas = Map<string, string>;

export class HomeAssistantRegistry extends Service {
  private autoRefresh?: NodeJS.Timeout;
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
    } catch (e) {
      // HA's WS endpoint can drop in-flight queries during HA's own startup,
      // and after maxAttempts withRetry gives up. Start empty rather than
      // tear down the addon. enableAutoRefresh keeps trying every tick.
      logger.warn(
        "Initial registry fetch failed, starting empty and relying on auto-refresh:",
        e,
      );
    }
  }

  override async dispose(): Promise<void> {
    this.disableAutoRefresh();
  }

  enableAutoRefresh(onRefresh: () => Promise<void> | void) {
    this.disableAutoRefresh();

    let refreshing = false;
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
        const changed = await this.reload();
        // stamp only now: a reload that failed must not consume the restart
        this.lastRunningSince = runningSince;
        if (changed || restarted) {
          await onRefresh();
        }
      } catch (e) {
        logger.warn("Failed to refresh registry, will retry next interval:", e);
      } finally {
        refreshing = false;
      }
    }, this.options.refreshInterval * 1000);
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
    // guaranteed on older HA versions, catch and fall back to empty arrays
    // without failing the whole reload.
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
        getLabelRegistry(connection, timeoutMs).catch(
          () => [] as HomeAssistantLabel[],
        ),
        getAreaRegistry(connection, timeoutMs).catch(
          () => [] as Array<{ area_id: string; name: string }>,
        ),
      ]);

    // Fingerprint structural registry data to detect changes.
    // State *values* change constantly (handled by WebSocket subscription);
    // we only check if entity/device/state IDs or key attributes changed.
    const hash = createHash("md5");
    for (const e of entityRegistry) {
      hash.update(
        `${e.entity_id}\0${e.device_id ?? ""}\0${e.disabled_by ?? ""}\0${e.hidden_by ?? ""}\0${e.area_id ?? ""}\0${(e.labels ?? []).join(",")}\0${e.platform ?? ""}\0${e.entity_category ?? ""}\0${e.name ?? ""}\0${e.original_name ?? ""}\n`,
      );
    }
    for (const s of statesList) {
      hash.update(`${s.entity_id}\0${s.attributes?.device_class ?? ""}\n`);
    }
    for (const d of deviceRegistry) {
      hash.update(
        `${d.id}\0${(d.labels ?? []).join(",")}\0${d.area_id ?? ""}\0${d.name_by_user ?? ""}\0${d.name ?? ""}\0${d.model ?? ""}\0${d.model_id ?? ""}\0${d.manufacturer ?? ""}\0${d.hw_version ?? ""}\0${d.sw_version ?? ""}\0${d.serial_number ?? ""}\n`,
      );
    }
    for (const l of labels) hash.update(`${l.label_id}\n`);
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
    this._states = keyBy(statesList, "entity_id");

    if (fingerprint === this.lastRegistryFingerprint) {
      logger.debug("Registry unchanged, skipping full refresh");
      return false;
    }
    this.lastRegistryFingerprint = fingerprint;

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
