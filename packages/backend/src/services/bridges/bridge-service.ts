import crypto from "node:crypto";
import type {
  BridgeBasicInformation,
  BridgeData,
  CreateBridgeRequest,
  UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { Service } from "../../core/ioc/service.js";
import {
  MAX_RECOVERY_INTERVAL_MS,
  MIN_RECOVERY_INTERVAL_MS,
  type RecoverySettings,
} from "../storage/app-settings-storage.js";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { Bridge } from "./bridge.js";
import type { BridgeFactory } from "./bridge-factory.js";

export interface BridgeServiceProps {
  basicInformation: BridgeBasicInformation;
  autoRecovery?: boolean;
  recoveryIntervalMs?: number;
}

export interface RecoveryAttempt {
  timestamp: string;
  bridgeId: string;
  bridgeName: string;
  outcome: "success" | "failed";
}

// Keep the interval sane even if it came from corrupted storage or a bad flag,
// so a 0 or NaN can never turn the timer into a tight loop.
function clampRecoveryInterval(ms: number): number {
  if (!Number.isFinite(ms)) return 60000;
  return Math.min(
    Math.max(ms, MIN_RECOVERY_INTERVAL_MS),
    MAX_RECOVERY_INTERVAL_MS,
  );
}

// a hung bridge must not keep the others from picking up registry changes
const REFRESH_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 5 * 60_000;

export class BridgeService extends Service {
  private readonly pendingPorts = new Set<number>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly slowRefreshes = new Map<string, boolean>();
  private readonly log = Logger.get("BridgeService");
  public readonly bridges: Bridge[] = [];
  public autoRecoveryEnabled = false;
  public lastRecoveryAttempt?: Date;
  public recoveryCount = 0;

  // Called whenever a bridge's status changes (start, stop, update, delete, recovery).
  // Set by the caller (e.g. start-handler) to broadcast updates via WebSocket.
  public onBridgeChanged?: (bridgeId: string) => void;

  private recoveryInterval?: ReturnType<typeof setInterval>;
  private recoveryIntervalMs = 60000;
  private recoveryInProgress = false;
  private _recoveryHistory: RecoveryAttempt[] = [];
  private lastReactiveRecovery = 0;
  private static readonly MAX_RECOVERY_HISTORY = 20;
  private static readonly REACTIVE_DEBOUNCE_MS = 5000;

  constructor(
    private readonly bridgeStorage: BridgeStorage,
    private readonly bridgeFactory: BridgeFactory,
    private readonly props: BridgeServiceProps,
  ) {
    super("BridgeService");
    this.autoRecoveryEnabled = props.autoRecovery ?? true;
    this.recoveryIntervalMs = clampRecoveryInterval(
      props.recoveryIntervalMs ?? 60000,
    );
  }

  protected override async initialize() {
    // Snapshot first: addBridge mutates this.bridges and we may rewrite a port.
    for (const data of [...this.bridgeStorage.bridges]) {
      let normalized = this.normalizeBridgeData(data);
      // the schema takes two letters only, a stored "USA" would fail every save
      if (
        normalized.countryCode != null &&
        !/^[A-Za-z]{2}$/.test(normalized.countryCode)
      ) {
        this.log.warn(
          `Bridge ${normalized.name} country code "${normalized.countryCode}" is not two letters, dropped`,
        );
        const { countryCode: _, ...rest } = normalized;
        normalized = rest;
      }
      if (this.portUsed(normalized.port)) {
        // Two stored bridges want the same port. Only one can bind it, so move
        // this one to a free port instead of letting it fail offline (#378).
        const freePort = this.getNextAvailablePort(normalized.port);
        this.log.warn(
          `Bridge ${normalized.name} port ${normalized.port} already in use, moved to ${freePort}`,
        );
        normalized = { ...normalized, port: freePort };
      }
      try {
        await this.bridgeStorage.add(normalized);
        await this.addBridge(normalized);
      } catch (e) {
        // one broken bridge must not keep the others from loading, its stored
        // record still owns the port
        this.pendingPorts.add(normalized.port);
        this.log.error(
          `Failed to load bridge ${normalized.id} (${normalized.name}):`,
          e,
        );
      }
    }
    if (this.autoRecoveryEnabled) {
      this.startAutoRecovery();
    }
  }

  private normalizeBridgeData(bridgeData: BridgeData): BridgeData {
    const { basicInformation } = bridgeData;
    return {
      ...bridgeData,
      basicInformation: {
        ...basicInformation,
        hardwareVersionString:
          basicInformation.hardwareVersionString ??
          this.props.basicInformation.hardwareVersionString ??
          String(basicInformation.hardwareVersion),
        softwareVersionString:
          basicInformation.softwareVersionString ??
          this.props.basicInformation.softwareVersionString ??
          String(basicInformation.softwareVersion),
      },
    };
  }

  private startAutoRecovery() {
    this.recoveryInterval = setInterval(() => {
      this.attemptRecovery();
    }, this.recoveryIntervalMs);
  }

  private stopAutoRecovery() {
    if (this.recoveryInterval) {
      clearInterval(this.recoveryInterval);
      this.recoveryInterval = undefined;
    }
  }

  get recoverySettings(): RecoverySettings {
    return {
      autoRecoveryEnabled: this.autoRecoveryEnabled,
      recoveryIntervalMs: this.recoveryIntervalMs,
    };
  }

  get recoveryHistory(): RecoveryAttempt[] {
    return [...this._recoveryHistory];
  }

  // Apply persisted recovery settings (at startup) or a change from the UI.
  applyRecoverySettings(settings: RecoverySettings) {
    this.autoRecoveryEnabled = settings.autoRecoveryEnabled;
    this.recoveryIntervalMs = clampRecoveryInterval(
      settings.recoveryIntervalMs,
    );
    this.stopAutoRecovery();
    if (this.autoRecoveryEnabled) {
      this.startAutoRecovery();
    }
  }

  // Run a recovery pass right away, e.g. just after Home Assistant reconnects,
  // instead of waiting for the next interval. Debounced so a burst of reconnect
  // events only triggers one pass. Still only touches failed bridges.
  recoverFailedBridgesNow() {
    if (!this.autoRecoveryEnabled) return;
    const now = Date.now();
    if (now - this.lastReactiveRecovery < BridgeService.REACTIVE_DEBOUNCE_MS) {
      return;
    }
    this.lastReactiveRecovery = now;
    void this.attemptRecovery();
  }

  private async attemptRecovery() {
    if (this.recoveryInProgress) return;
    const failedBridges = this.bridges.filter(
      (b) => b.data.status === "failed",
    );
    if (failedBridges.length === 0) return;

    this.recoveryInProgress = true;
    this.lastRecoveryAttempt = new Date();
    try {
      for (const bridge of failedBridges) {
        try {
          await bridge.start();
          // start() catches its own errors and leaves the bridge failed
          if (bridge.data.status !== "running") {
            this.log.warn(`Recovery attempt failed for bridge ${bridge.id}`);
            this.recordRecovery(bridge, "failed");
            continue;
          }
          this.recoveryCount++;
          this.recordRecovery(bridge, "success");
        } catch (e) {
          this.log.warn(`Recovery attempt failed for bridge ${bridge.id}:`, e);
          this.recordRecovery(bridge, "failed");
        }
      }
    } finally {
      this.recoveryInProgress = false;
    }
  }

  private recordRecovery(bridge: Bridge, outcome: "success" | "failed") {
    this._recoveryHistory.push({
      timestamp: new Date().toISOString(),
      bridgeId: bridge.id,
      bridgeName: bridge.data.name,
      outcome,
    });
    if (this._recoveryHistory.length > BridgeService.MAX_RECOVERY_HISTORY) {
      this._recoveryHistory.shift();
    }
  }

  async restartBridge(bridgeId: string): Promise<boolean> {
    const bridge = this.get(bridgeId);
    if (!bridge) return false;
    await bridge.stop();
    await bridge.start();
    return true;
  }
  override async dispose(): Promise<void> {
    this.stopAutoRecovery();
    await Promise.all(this.bridges.map((bridge) => bridge.dispose()));
  }

  getNextAvailablePort(startPort = 5540): number {
    const usedPorts = new Set([
      ...this.bridges.map((b) => b.data.port),
      ...this.pendingPorts,
    ]);
    let port = startPort;
    while (usedPorts.has(port)) {
      port++;
    }
    return port;
  }

  async startAll() {
    // Sort bridges by priority (lower = starts first), default priority is 100
    const sortedBridges = [...this.bridges].sort((a, b) => {
      const priorityA = a.data.priority ?? 100;
      const priorityB = b.data.priority ?? 100;
      return priorityA - priorityB;
    });
    for (const bridge of sortedBridges) {
      try {
        const start = bridge.start();
        if (!(await this.settlesWithin(start, START_TIMEOUT_MS))) {
          this.log.warn(
            `Start of bridge ${bridge.id} still pending after ${START_TIMEOUT_MS / 60_000} min, continuing with the next bridge`,
          );
          start.catch((e) =>
            this.log.error(`Failed to start bridge ${bridge.id}:`, e),
          );
        }
      } catch (e) {
        // Isolate per-bridge failures so one failing bridge doesn't prevent others from starting
        this.log.error(`Failed to start bridge ${bridge.id}:`, e);
      }
    }
  }

  async stopAll() {
    // Stop all bridges in parallel, stops are independent and a multi-bridge
    // shutdown should not wait for each one serially.
    await Promise.all(
      this.bridges.map(async (bridge) => {
        try {
          await bridge.stop();
          this.onBridgeChanged?.(bridge.id);
        } catch (e) {
          this.log.error(`Failed to stop bridge ${bridge.id}:`, e);
        }
      }),
    );
  }

  async restartAll() {
    // Stop in parallel (no ordering requirement), then start sequentially
    // by priority so low-priority bridges always come up first.
    await Promise.all(
      this.bridges.map(async (bridge) => {
        try {
          await bridge.stop();
        } catch (e) {
          this.log.error(
            `Failed to stop bridge ${bridge.id} during restart:`,
            e,
          );
        }
      }),
    );
    const sortedBridges = [...this.bridges].sort((a, b) => {
      const priorityA = a.data.priority ?? 100;
      const priorityB = b.data.priority ?? 100;
      return priorityA - priorityB;
    });
    for (const bridge of sortedBridges) {
      try {
        await bridge.start();
        this.onBridgeChanged?.(bridge.id);
      } catch (e) {
        this.log.error(
          `Failed to start bridge ${bridge.id} during restart:`,
          e,
        );
      }
    }
  }

  async refreshAll(): Promise<boolean> {
    let complete = true;
    // a delete finishing mid-pass must not shift the next bridge out of the loop
    for (const bridge of [...this.bridges]) {
      if (this.deleting.has(bridge.id)) continue;
      // the follow-up of a slow refresh owns this bridge, not the caller's retries
      if (this.slowRefreshes.has(bridge.id)) {
        this.slowRefreshes.set(bridge.id, true);
        continue;
      }
      try {
        const refresh = bridge.refreshDevices();
        const settled = await this.settlesWithin(refresh, REFRESH_TIMEOUT_MS);
        if (!settled) {
          this.log.warn(
            `Refresh of bridge ${bridge.id} did not finish within ${REFRESH_TIMEOUT_MS / 1000} s, continuing with the next bridge`,
          );
          this.slowRefreshes.set(bridge.id, false);
          const failed = (e: unknown) =>
            this.log.error(`Failed to refresh bridge ${bridge.id}:`, e);
          // a delete removes the bridge from the list only after stopping it
          const live = () =>
            this.bridges.includes(bridge) && !this.deleting.has(bridge.id);
          void refresh.catch(failed).then(async () => {
            try {
              while (live()) {
                this.slowRefreshes.set(bridge.id, false);
                try {
                  if (!(await bridge.refreshDevices())) {
                    this.log.warn(
                      `Refresh of bridge ${bridge.id} is still incomplete`,
                    );
                  }
                } catch (e) {
                  failed(e);
                }
                try {
                  if (live()) this.onBridgeChanged?.(bridge.id);
                } catch (e) {
                  failed(e);
                }
                // a pass skipped during this attempt may carry a newer registry change
                if (!this.slowRefreshes.get(bridge.id)) break;
              }
            } finally {
              this.slowRefreshes.delete(bridge.id);
            }
          });
          continue;
        }
        this.onBridgeChanged?.(bridge.id);
        if (!settled.value) complete = false;
      } catch (e) {
        complete = false;
        // Isolate per-bridge failures so one failing bridge doesn't block others
        this.log.error(`Failed to refresh bridge ${bridge.id}:`, e);
      }
    }
    return complete;
  }

  // undefined when the work is still running after ms, rejects with its error
  private async settlesWithin<T>(
    work: Promise<T>,
    ms: number,
  ): Promise<{ value: T } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
      return await Promise.race([work.then((value) => ({ value })), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  get(id: string): Bridge | undefined {
    return this.bridges.find((bridge) => bridge.id === id);
  }

  async create(request: CreateBridgeRequest): Promise<Bridge> {
    // assign the next free port server-side when the request omits it
    const port = request.port ?? this.getNextAvailablePort();
    if (this.portUsed(port)) {
      throw new Error(`Port already in use: ${port}`);
    }
    // two creates racing on the same free port must not both pass
    this.pendingPorts.add(port);
    try {
      const bridge = await this.addBridge({
        ...request,
        port,
        id: crypto.randomUUID().replace(/-/g, ""),
        basicInformation: this.props.basicInformation,
      });
      await this.bridgeStorage.add(bridge.data);
      await bridge.start();
      this.onBridgeChanged?.(bridge.id);
      return bridge;
    } finally {
      this.pendingPorts.delete(port);
    }
  }

  // Apply an imported bridge live: overwrite the bridge with the same id or
  // add and start a new one. A taken port moves like it would on startup.
  async importBridge(data: BridgeData): Promise<Bridge> {
    const port = this.portUsed(data.port, [data.id])
      ? this.getNextAvailablePort(data.port)
      : data.port;
    const existing = this.get(data.id);
    if (existing) {
      const { basicInformation: _, ...config } = data;
      await this.update({ ...config, port });
      return existing;
    }
    this.pendingPorts.add(port);
    try {
      const bridge = await this.addBridge(
        this.normalizeBridgeData({ ...data, port }),
      );
      await this.bridgeStorage.add(bridge.data);
      await bridge.start();
      this.onBridgeChanged?.(bridge.id);
      return bridge;
    } finally {
      this.pendingPorts.delete(port);
    }
  }

  async update(request: UpdateBridgeRequest): Promise<Bridge | undefined> {
    if (this.portUsed(request.port, [request.id])) {
      throw new Error(`Port already in use: ${request.port}`);
    }
    const bridge = this.get(request.id);
    if (!bridge) {
      return;
    }
    await bridge.update(request);
    // a delete that ran meanwhile already removed it from storage
    if (!this.bridges.includes(bridge)) return;
    await this.bridgeStorage.add(bridge.data);
    this.onBridgeChanged?.(bridge.id);
    return bridge;
  }

  delete(bridgeId: string): Promise<void> {
    // a second delete while one runs (double click) waits for the first
    let pending = this.deleting.get(bridgeId);
    if (!pending) {
      pending = this.runDelete(bridgeId).finally(() =>
        this.deleting.delete(bridgeId),
      );
      this.deleting.set(bridgeId, pending);
    }
    return pending;
  }

  private async runDelete(bridgeId: string): Promise<void> {
    const bridge = this.bridges.find((bridge) => bridge.id === bridgeId);
    if (!bridge) {
      // a stored bridge that failed to load is not live but keeps its port
      const stored = this.bridgeStorage.bridges.find((b) => b.id === bridgeId);
      if (stored) {
        await this.bridgeStorage.remove(bridgeId);
        this.pendingPorts.delete(stored.port);
        this.onBridgeChanged?.(bridgeId);
      }
      return;
    }
    await bridge.stop();
    try {
      await bridge.delete();
    } catch (e) {
      // Ignore Matter.js internal errors during deletion
      // These occur when endpoints are already detached from the node
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("Endpoint storage inaccessible")) {
        throw e;
      }
    }
    try {
      await bridge.dispose();
    } catch {
      // Ignore disposal errors during deletion
    }
    const index = this.bridges.indexOf(bridge);
    if (index >= 0) this.bridges.splice(index, 1);
    await this.bridgeStorage.remove(bridgeId);
    this.onBridgeChanged?.(bridgeId);
  }

  async updatePriorities(
    updates: Array<{ id: string; priority: number }>,
  ): Promise<void> {
    for (const update of updates) {
      const bridge = this.get(update.id);
      if (bridge) {
        // An update replaces the config, so carry every optional key over
        const currentData = bridge.data;
        await this.update({
          id: update.id,
          name: currentData.name,
          port: currentData.port,
          filter: currentData.filter,
          featureFlags: currentData.featureFlags,
          countryCode: currentData.countryCode,
          icon: currentData.icon,
          serialNumberSuffix: currentData.serialNumberSuffix,
          uniqueIdSuffix: currentData.uniqueIdSuffix,
          sessionMaxAgeHours: currentData.sessionMaxAgeHours,
          priority: update.priority,
        });
      }
    }
  }

  private async addBridge(bridgeData: BridgeData): Promise<Bridge> {
    const bridge = await this.bridgeFactory.create(bridgeData);
    // Wire up status change notifications so every transition
    // (Stopped → Starting → Running / Failed) is broadcast via WebSocket.
    bridge.onStatusChange = () => this.onBridgeChanged?.(bridge.id);
    this.bridges.push(bridge);
    return bridge;
  }

  private portUsed(port: number, notId?: string[]): boolean {
    if (this.pendingPorts.has(port)) return true;
    return this.bridges
      .filter((bridge) => notId == null || !notId.includes(bridge.id))
      .some((bridge) => bridge.data.port === port);
  }
}
