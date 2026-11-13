import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@matter/general";
import type { PluginStorage } from "./types.js";

const logger = Logger.get("PluginStorage");

/**
 * File-based persistent storage for a plugin instance. One JSON file per bridge
 * and plugin so plugin config edited on one bridge stays there (#373).
 */
const SAVE_DEBOUNCE_MS = 500;

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// Path of the JSON file backing one bridge+plugin pair. Shared so #419 can
// read a bridge's camera config without instantiating the storage.
export function pluginStorageFilePath(
  storageDir: string,
  bridgeId: string,
  pluginName: string,
): string {
  return path.join(
    storageDir,
    `plugin-${safe(bridgeId)}-${safe(pluginName)}.json`,
  );
}

// The manager's per-bridge state file (enabled flags). Kept apart from the
// plugin files so a plugin-owned key can never collide with it (#439).
export function pluginStateFilePath(
  storageDir: string,
  bridgeId: string,
): string {
  return path.join(storageDir, `plugin-state-${safe(bridgeId)}.json`);
}

// A deleted bridge's plugin files hold HA tokens and passwords. Ids can share
// a prefix (ab, ab-x), a file of a longer other id is not this bridge's.
export function removePluginFiles(
  storageDir: string,
  bridgeId: string,
  otherBridgeIds: string[],
): void {
  const prefix = `plugin-${safe(bridgeId)}-`;
  const longer = otherBridgeIds
    .map((id) => `plugin-${safe(id)}-`)
    .filter((p) => p.length > prefix.length && p.startsWith(prefix));
  const othersState = new Set(
    otherBridgeIds.map((id) => path.basename(pluginStateFilePath("", id))),
  );
  const ownState = path.basename(pluginStateFilePath("", bridgeId));
  let names: string[];
  try {
    names = fs.readdirSync(storageDir);
  } catch {
    return;
  }
  for (const name of names) {
    const own =
      name === ownState ||
      (name.startsWith(prefix) &&
        /\.json(\.tmp)?$/.test(name) &&
        !othersState.has(name) &&
        !longer.some((p) => name.startsWith(p)));
    if (!own) continue;
    try {
      fs.rmSync(path.join(storageDir, name), { force: true });
    } catch (e) {
      logger.warn(`Failed to remove plugin file ${name}:`, e);
    }
  }
}

export class FilePluginStorage implements PluginStorage {
  private data: Record<string, unknown> = {};
  private dirty = false;
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(storageDir: string, bridgeId: string, pluginName: string) {
    this.filePath = pluginStorageFilePath(storageDir, bridgeId, pluginName);
    this.load();
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = this.data[key];
    return (value as T) ?? defaultValue;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data[key] = value;
    this.dirty = true;
    this.scheduleSave();
  }

  async delete(key: string): Promise<void> {
    delete this.data[key];
    this.dirty = true;
    this.scheduleSave();
  }

  async keys(): Promise<string[]> {
    return Object.keys(this.data);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch (e) {
      logger.warn(`Failed to load plugin storage from ${this.filePath}:`, e);
      this.data = {};
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    if (!this.dirty) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // A crash mid-write leaves the old file, a torn one would load as {}.
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmpPath, this.filePath);
      this.dirty = false;
    } catch (e) {
      logger.warn(`Failed to save plugin storage to ${this.filePath}:`, e);
    }
  }

  flush(): void {
    this.save();
  }
}
