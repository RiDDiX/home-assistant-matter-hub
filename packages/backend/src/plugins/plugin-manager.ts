import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@matter/general";
import { getSupportedPluginDeviceTypes } from "./plugin-device-factory.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { FilePluginStorage } from "./plugin-storage.js";
import {
  type CircuitBreakerState,
  SafePluginRunner,
} from "./safe-plugin-runner.js";
import {
  type MatterHubPlugin,
  type MatterHubPluginConstructor,
  type PluginConfigSchema,
  type PluginContext,
  type PluginDevice,
  type PluginDomainMapping,
  type PluginMetadata,
  SECRET_UNCHANGED,
} from "./types.js";

const logger = Logger.get("PluginManager");

export const PLUGIN_API_VERSION = 1;

const MAX_PLUGIN_DEVICE_ID_LENGTH = 100;

function validatePluginDevice(device: unknown): string | undefined {
  if (!device || typeof device !== "object") return "device must be an object";
  const d = device as Record<string, unknown>;
  if (!d.id || typeof d.id !== "string")
    return "device.id must be a non-empty string";
  if ((d.id as string).length > MAX_PLUGIN_DEVICE_ID_LENGTH)
    return `device.id too long (${(d.id as string).length} chars, max ${MAX_PLUGIN_DEVICE_ID_LENGTH})`;
  if (!d.name || typeof d.name !== "string")
    return "device.name must be a non-empty string";
  // A device is built either from a built-in deviceType string or from a
  // plugin-supplied matter.js endpointType (custom clusters/commands).
  const hasEndpointType =
    d.endpointType != null && typeof d.endpointType === "object";
  if (!hasEndpointType) {
    if (!d.deviceType || typeof d.deviceType !== "string")
      return "device.deviceType must be a non-empty string (or provide endpointType)";
    const supported = getSupportedPluginDeviceTypes();
    if (!supported.includes(d.deviceType as string))
      return `unsupported deviceType "${d.deviceType}". Supported: ${supported.join(", ")}`;
  }
  if (!Array.isArray(d.clusters)) return "device.clusters must be an array";
  for (let i = 0; i < (d.clusters as unknown[]).length; i++) {
    const c = (d.clusters as unknown[])[i];
    if (!c || typeof c !== "object") return `clusters[${i}] must be an object`;
    const cc = c as Record<string, unknown>;
    if (!cc.clusterId || typeof cc.clusterId !== "string")
      return `clusters[${i}].clusterId must be a non-empty string`;
  }
  return undefined;
}

interface PluginInstance {
  plugin: MatterHubPlugin;
  context: PluginContext;
  metadata: PluginMetadata;
  devices: Map<string, PluginDevice>;
  started: boolean;
}

/**
 * Manages plugin lifecycle, device registration, and state updates.
 *
 * Each bridge gets its own PluginManager instance. Plugins register devices
 * which are then exposed as Matter endpoints on the bridge.
 */
export class PluginManager {
  private readonly instances = new Map<string, PluginInstance>();
  private readonly domainMappings = new Map<string, PluginDomainMapping>();
  private readonly domainMappingOwners = new Map<string, string>();
  private readonly storageDir: string;
  private readonly bridgeId: string;
  private readonly homeAssistant?: { url: string; accessToken: string };
  private readonly runner = new SafePluginRunner();
  private registry?: PluginRegistry;

  /** Callback invoked when a plugin registers a new device */
  onDeviceRegistered?: (
    pluginName: string,
    device: PluginDevice,
  ) => Promise<void>;

  /** Callback invoked when a plugin removes a device */
  onDeviceUnregistered?: (
    pluginName: string,
    deviceId: string,
  ) => Promise<void>;

  /** Callback invoked when a plugin updates device state */
  onDeviceStateUpdated?: (
    pluginName: string,
    deviceId: string,
    clusterId: string,
    attributes: Record<string, unknown>,
  ) => void;

  constructor(
    bridgeId: string,
    storageDir: string,
    homeAssistant?: { url: string; accessToken: string },
  ) {
    this.bridgeId = bridgeId;
    this.storageDir = storageDir;
    this.homeAssistant = homeAssistant;
  }

  setRegistry(registry: PluginRegistry) {
    this.registry = registry;
  }

  /**
   * Load and register a built-in plugin instance.
   */
  async registerBuiltIn(plugin: MatterHubPlugin): Promise<void> {
    const metadata: PluginMetadata = {
      name: plugin.name,
      version: plugin.version,
      source: "builtin",
      enabled: true,
      config: {},
    };
    await this.register(plugin, metadata);
  }

  /**
   * Load an external plugin from an npm package path.
   */
  async loadExternal(
    packagePath: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Validate manifest before executing any plugin code
      const pkgJsonPath = path.join(packagePath, "package.json");
      if (!fs.existsSync(pkgJsonPath)) {
        throw new Error(`Plugin at ${packagePath} has no package.json`);
      }
      let manifest: {
        name?: string;
        version?: string;
        main?: string;
        hamhPluginApiVersion?: number;
      };
      try {
        manifest = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      } catch {
        throw new Error(`Plugin at ${packagePath} has invalid package.json`);
      }
      if (!manifest.name || typeof manifest.name !== "string") {
        throw new Error(`Plugin at ${packagePath} package.json missing "name"`);
      }
      if (!manifest.main || typeof manifest.main !== "string") {
        throw new Error(`Plugin at ${packagePath} package.json missing "main"`);
      }
      if (
        manifest.hamhPluginApiVersion != null &&
        manifest.hamhPluginApiVersion !== PLUGIN_API_VERSION
      ) {
        logger.warn(
          `Plugin "${manifest.name}" declares API version ${manifest.hamhPluginApiVersion}, current is ${PLUGIN_API_VERSION}. It may not work correctly.`,
        );
      }

      const module = await this.runner.run(
        manifest.name,
        "import",
        () => import(packagePath),
        15_000,
      );
      if (!module) {
        throw new Error(
          `Plugin at ${packagePath} failed to load (timeout or error)`,
        );
      }
      const PluginClass: MatterHubPluginConstructor =
        module.default ?? module.MatterHubPlugin;

      if (!PluginClass || typeof PluginClass !== "function") {
        throw new Error(
          `Plugin at ${packagePath} does not export a valid MatterHubPlugin class`,
        );
      }

      const plugin = new PluginClass(config);
      const metadata: PluginMetadata = {
        name: plugin.name,
        version: plugin.version,
        source: packagePath,
        enabled: true,
        config,
      };

      await this.register(plugin, metadata);
    } catch (e) {
      logger.error(`Failed to load external plugin from ${packagePath}:`, e);
      throw e;
    }
  }

  private async register(
    plugin: MatterHubPlugin,
    metadata: PluginMetadata,
  ): Promise<void> {
    if (this.instances.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    const storage = new FilePluginStorage(
      this.storageDir,
      this.bridgeId,
      plugin.name,
    );
    const devices = new Map<string, PluginDevice>();
    const pluginLogger = Logger.get(`Plugin:${plugin.name}`);

    const context: PluginContext = {
      bridgeId: this.bridgeId,
      storage,
      log: pluginLogger,
      homeAssistant: this.homeAssistant,

      registerDevice: async (device: PluginDevice) => {
        const validationError = validatePluginDevice(device);
        if (validationError) {
          pluginLogger.warn(`Rejected device registration: ${validationError}`);
          return;
        }
        if (devices.has(device.id)) {
          pluginLogger.warn(
            `Device "${device.id}" already registered, updating`,
          );
        }
        devices.set(device.id, device);
        await this.onDeviceRegistered?.(plugin.name, device);
        pluginLogger.debug(`Registered device: ${device.name} (${device.id})`);
      },

      unregisterDevice: async (deviceId: string) => {
        if (!devices.has(deviceId)) {
          pluginLogger.warn(`Device "${deviceId}" not found`);
          return;
        }
        devices.delete(deviceId);
        await this.onDeviceUnregistered?.(plugin.name, deviceId);
        pluginLogger.debug(`Unregistered device: ${deviceId}`);
      },

      updateDeviceState: (
        deviceId: string,
        clusterId: string,
        attributes: Record<string, unknown>,
      ) => {
        if (!devices.has(deviceId)) {
          pluginLogger.warn(
            `Cannot update state: device "${deviceId}" not found`,
          );
          return;
        }
        this.onDeviceStateUpdated?.(
          plugin.name,
          deviceId,
          clusterId,
          attributes,
        );
      },

      registerDomainMapping: (mapping: PluginDomainMapping) => {
        if (
          !mapping.domain ||
          typeof mapping.domain !== "string" ||
          !mapping.matterDeviceType ||
          typeof mapping.matterDeviceType !== "string"
        ) {
          pluginLogger.warn("Invalid domain mapping, skipping");
          return;
        }
        if (this.domainMappings.has(mapping.domain)) {
          pluginLogger.warn(
            `Domain "${mapping.domain}" already mapped by another plugin, overwriting`,
          );
        }
        this.domainMappings.set(mapping.domain, mapping);
        this.domainMappingOwners.set(mapping.domain, plugin.name);
        pluginLogger.info(
          `Registered domain mapping: ${mapping.domain} → ${mapping.matterDeviceType}`,
        );
      },
    };

    this.instances.set(plugin.name, {
      plugin,
      context,
      metadata,
      devices,
      started: false,
    });
    logger.info(
      `Registered plugin: ${plugin.name} v${plugin.version} (${metadata.source})`,
    );
  }

  /**
   * Start all registered plugins via SafePluginRunner.
   */
  async startAll(): Promise<void> {
    for (const [name, instance] of this.instances) {
      if (!instance.metadata.enabled) continue;
      if (this.runner.isDisabled(name)) {
        logger.warn(
          `Plugin "${name}" is disabled (circuit breaker), skipping start`,
        );
        instance.metadata.enabled = false;
        continue;
      }
      logger.info(`Starting plugin: ${name}`);
      await this.runner.run(name, "onStart", () =>
        instance.plugin.onStart(instance.context),
      );
      if (this.runner.isDisabled(name)) {
        instance.metadata.enabled = false;
      } else if (this.runner.getState(name).failures === 0) {
        instance.started = true;
      }
      // onStart may merge persisted config, keep the listing in sync
      if (instance.plugin.getCurrentConfig) {
        instance.metadata.config = instance.plugin.getCurrentConfig();
      }
    }
  }

  /**
   * Configure all started plugins via SafePluginRunner.
   */
  async configureAll(): Promise<void> {
    for (const [name, instance] of this.instances) {
      if (!instance.metadata.enabled) continue;
      if (instance.plugin.onConfigure) {
        await this.runner.run(name, "onConfigure", () =>
          instance.plugin.onConfigure!(),
        );
        if (this.runner.isDisabled(name)) {
          instance.metadata.enabled = false;
        }
      }
    }
  }

  /**
   * Shut down all plugins via SafePluginRunner.
   */
  async shutdownAll(reason?: string): Promise<void> {
    for (const [name, instance] of this.instances) {
      if (instance.started && instance.plugin.onShutdown) {
        await this.runner.run(name, "onShutdown", () =>
          instance.plugin.onShutdown!(reason),
        );
      }
      const storage = instance.context.storage;
      if (storage instanceof FilePluginStorage) {
        storage.flush();
      }
      instance.started = false;
      logger.info(`Plugin "${name}" shut down`);
    }
    this.instances.clear();
  }

  getPlugin(name: string): MatterHubPlugin | undefined {
    return this.instances.get(name)?.plugin;
  }

  getMetadata(): PluginMetadata[] {
    return Array.from(this.instances.values()).map((i) => i.metadata);
  }

  getDevices(pluginName: string): PluginDevice[] {
    const instance = this.instances.get(pluginName);
    return instance ? Array.from(instance.devices.values()) : [];
  }

  getAllDevices(): Array<{ pluginName: string; device: PluginDevice }> {
    const result: Array<{ pluginName: string; device: PluginDevice }> = [];
    for (const [pluginName, instance] of this.instances) {
      for (const device of instance.devices.values()) {
        result.push({ pluginName, device });
      }
    }
    return result;
  }

  getCircuitBreakerStates(): Map<string, CircuitBreakerState> {
    return this.runner.getAllStates();
  }

  resetPlugin(pluginName: string): void {
    this.runner.resetCircuitBreaker(pluginName);
    const instance = this.instances.get(pluginName);
    if (instance) {
      instance.metadata.enabled = true;
    }
  }

  disablePlugin(pluginName: string): void {
    const instance = this.instances.get(pluginName);
    if (instance) {
      instance.metadata.enabled = false;
    }
    for (const [domain, owner] of this.domainMappingOwners) {
      if (owner === pluginName) {
        this.domainMappings.delete(domain);
        this.domainMappingOwners.delete(domain);
      }
    }
  }

  enablePlugin(pluginName: string): void {
    this.runner.resetCircuitBreaker(pluginName);
    const instance = this.instances.get(pluginName);
    if (instance) {
      instance.metadata.enabled = true;
    }
  }

  getConfigSchema(pluginName: string): PluginConfigSchema | undefined {
    const instance = this.instances.get(pluginName);
    if (!instance) return undefined;
    return instance.plugin.getConfigSchema?.();
  }

  getDomainMappings(): Map<string, PluginDomainMapping> {
    return new Map(this.domainMappings);
  }

  async updateConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const instance = this.instances.get(pluginName);
    if (!instance) return false;
    config = { ...config };
    // The listing redacts secret fields to the placeholder; a save carrying
    // it back means "keep what is stored", never store the placeholder itself.
    const schema = instance.plugin.getConfigSchema?.();
    if (schema) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.secret && config[key] === SECRET_UNCHANGED) {
          const stored = instance.metadata.config[key];
          if (stored == null) delete config[key];
          else config[key] = stored;
        }
      }
    }
    instance.metadata.config = config;
    this.registry?.updateConfig(pluginName, config);
    if (instance.plugin.onConfigChanged) {
      await this.runner.run(pluginName, "onConfigChanged", () =>
        instance.plugin.onConfigChanged!(config),
      );
    }
    return true;
  }
}
