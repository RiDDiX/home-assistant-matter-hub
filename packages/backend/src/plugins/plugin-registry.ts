import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@matter/general";

const logger = Logger.get("PluginRegistry");

export interface InstalledPlugin {
  /** npm package name (e.g., "hamh-plugin-example") */
  packageName: string;
  /** Optional config passed to the plugin constructor */
  config: Record<string, unknown>;
  /** Whether the plugin should be auto-loaded on bridge start */
  autoLoad: boolean;
  /** When it was installed */
  installedAt: number;
}

/**
 * Persists the list of installed plugins to a JSON file in the storage
 * directory so the loader knows which npm packages to pick up on startup.
 */
export class PluginRegistry {
  private plugins: InstalledPlugin[] = [];
  private readonly filePath: string;

  constructor(storageLocation: string) {
    this.filePath = path.join(storageLocation, "installed-plugins.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.plugins = JSON.parse(raw);
      }
    } catch (e) {
      logger.warn("Failed to load plugin registry:", e);
      this.plugins = [];
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.plugins, null, 2),
        "utf-8",
      );
    } catch (e) {
      logger.error("Failed to save plugin registry:", e);
    }
  }

  getAll(): InstalledPlugin[] {
    return [...this.plugins];
  }

  get(packageName: string): InstalledPlugin | undefined {
    return this.plugins.find((p) => p.packageName === packageName);
  }

  add(
    packageName: string,
    config: Record<string, unknown> = {},
  ): InstalledPlugin {
    const existing = this.get(packageName);
    if (existing) {
      existing.config = config;
      this.save();
      return existing;
    }
    const entry: InstalledPlugin = {
      packageName,
      config,
      autoLoad: true,
      installedAt: Date.now(),
    };
    this.plugins.push(entry);
    this.save();
    return entry;
  }

  remove(packageName: string): boolean {
    const idx = this.plugins.findIndex((p) => p.packageName === packageName);
    if (idx === -1) return false;
    this.plugins.splice(idx, 1);
    this.save();
    return true;
  }

  updateConfig(packageName: string, config: Record<string, unknown>): boolean {
    const plugin = this.get(packageName);
    if (!plugin) return false;
    plugin.config = config;
    this.save();
    return true;
  }

  setAutoLoad(packageName: string, autoLoad: boolean): boolean {
    const plugin = this.get(packageName);
    if (!plugin) return false;
    plugin.autoLoad = autoLoad;
    this.save();
    return true;
  }
}
