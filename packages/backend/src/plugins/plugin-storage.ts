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

// Path of the JSON file backing one bridge+plugin pair. Shared so #419 can
// read a bridge's camera config without instantiating the storage.
export function pluginStorageFilePath(
  storageDir: string,
  bridgeId: string,
  pluginName: string,
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(
    storageDir,
    `plugin-${safe(bridgeId)}-${safe(pluginName)}.json`,
  );
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
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch (e) {
      logger.warn(`Failed to save plugin storage to ${this.filePath}:`, e);
    }
  }

  flush(): void {
    this.save();
  }
}
