import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@matter/general";
import { getSupportedPluginDeviceTypes } from "./plugin-device-factory.js";
import type { PluginRegistry } from "./plugin-registry.js";
import { FilePluginStorage, pluginStateFilePath } from "./plugin-storage.js";
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

// Older builds kept the enable choice inside the plugin's own storage file,
// where a plugin-owned key of the same name collides. Migrated on first read.
const LEGACY_ENABLED_KEY = "__enabled";

// The storage key plugins read their persisted config from in onStart. A
// parked save has to land there before the enable start runs (#439).
const PLUGIN_CONFIG_KEY = "config";

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
  // Config saved while the plugin was disabled, applied on enable so the
  // save cannot remount devices behind the disable.
  pendingConfig?: Record<string, unknown>;
  // Transitions chain here so they run one at a time per plugin: a disable
  // arriving during a slow start waits for the start to settle.
  queue: Promise<unknown>;
  // Bumped on disable and on every start. A registration carrying an older
  // epoch comes from a superseded start and is dropped.
  epoch: number;
  // Fresh context per start so late registrations carry their start's epoch.
  contextAt: (epoch: number) => PluginContext;
  // True while a reversible stop (disable, bridge shutdown) unmounts the
  // devices, so the endpoints keep their persisted numbers.
  suspending: boolean;
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
  private readonly stateFile: string;
  private readonly homeAssistant?: { url: string; accessToken: string };
  private readonly runner = new SafePluginRunner();
  private registry?: PluginRegistry;

  /** Callback invoked when a plugin registers a new device */
  onDeviceRegistered?: (
    pluginName: string,
    device: PluginDevice,
  ) => Promise<void>;

  /**
   * Callback invoked when a plugin removes a device. keepIdentity marks a
   * reversible stop: the endpoint closes but keeps its persisted number.
   */
  onDeviceUnregistered?: (
    pluginName: string,
    deviceId: string,
    options?: { keepIdentity?: boolean },
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
    this.stateFile = pluginStateFilePath(storageDir, bridgeId);
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
    // A disable from a previous run survives the restart (#439). The choice
    // lives in the manager's own state file; a boolean under the legacy key
    // in the plugin's storage is honored once and handed back to the plugin.
    let enabled = this.readEnabledState()[plugin.name];
    const legacy = await storage.get<unknown>(LEGACY_ENABLED_KEY);
    if (typeof legacy === "boolean") {
      if (enabled === undefined) {
        enabled = legacy;
        this.persistEnabled(plugin.name, legacy);
      }
      await storage.delete(LEGACY_ENABLED_KEY);
      storage.flush();
    }
    if (enabled === false) {
      metadata.enabled = false;
      logger.info(`Plugin "${plugin.name}" stays disabled (persisted)`);
    }
    const devices = new Map<string, PluginDevice>();
    const pluginLogger = Logger.get(`Plugin:${plugin.name}`);

    const registerDeviceAt =
      (epoch: number) => async (device: PluginDevice) => {
        const live = this.instances.get(plugin.name);
        if (!live || !live.metadata.enabled || live.epoch !== epoch) {
          pluginLogger.warn(
            `Dropped a device registration from a disabled or superseded start of "${plugin.name}"`,
          );
          return;
        }
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
      };

    const context: PluginContext = {
      bridgeId: this.bridgeId,
      storage,
      log: pluginLogger,
      homeAssistant: this.homeAssistant,

      registerDevice: registerDeviceAt(0),

      unregisterDevice: async (deviceId: string) => {
        if (!devices.has(deviceId)) {
          pluginLogger.warn(`Device "${deviceId}" not found`);
          return;
        }
        devices.delete(deviceId);
        // Always keep the number. Plugins unregister to rebuild after a
        // config edit too, and deleting there re-mints every device, so
        // controllers drop them from groups (#438). Cost of keeping it: one
        // parked number per device that never comes back.
        await this.onDeviceUnregistered?.(plugin.name, deviceId, {
          keepIdentity: true,
        });
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
      queue: Promise.resolve(),
      epoch: 0,
      contextAt: (epoch) => ({
        ...context,
        registerDevice: registerDeviceAt(epoch),
      }),
      suspending: false,
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
      await this.inTransition(instance, () => this.startPlugin(name, instance));
    }
  }

  // One transition at a time per plugin: a disable during a slow start waits
  // for the start to settle instead of interleaving with it.
  private inTransition<T>(
    instance: PluginInstance,
    fn: () => Promise<T>,
  ): Promise<T> {
    const run = instance.queue.then(fn, fn);
    instance.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startPlugin(
    name: string,
    instance: PluginInstance,
  ): Promise<void> {
    if (!instance.metadata.enabled) return;
    if (this.runner.isDisabled(name)) {
      logger.warn(
        `Plugin "${name}" is disabled (circuit breaker), skipping start`,
      );
      instance.metadata.enabled = false;
      return;
    }
    logger.info(`Starting plugin: ${name}`);
    const epoch = ++instance.epoch;
    await this.runner.run(name, "onStart", () =>
      instance.plugin.onStart(instance.contextAt(epoch)),
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
   * Shut down all plugins. Runs outside the circuit breaker: cleanup must
   * happen even for a plugin the breaker took down.
   */
  async shutdownAll(reason?: string): Promise<void> {
    for (const [name, instance] of this.instances) {
      await this.inTransition(instance, async () => {
        instance.epoch++;
        instance.suspending = true;
        try {
          if (instance.started && instance.plugin.onShutdown) {
            await this.runner.runCleanup(name, "onShutdown", () =>
              instance.plugin.onShutdown!(reason),
            );
          }
        } finally {
          instance.suspending = false;
        }
        const storage = instance.context.storage;
        if (storage instanceof FilePluginStorage) {
          storage.flush();
        }
        instance.started = false;
        logger.info(`Plugin "${name}" shut down`);
      });
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

  /**
   * Disable a plugin: stop it, unmount its devices, and persist the choice so
   * a bridge restart does not bring it back (#439). The shutdown runs outside
   * the circuit breaker, a broken plugin still has to release its resources.
   * Returns the resulting metadata, or undefined for an unknown name.
   */
  async disablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    const instance = this.instances.get(pluginName);
    if (!instance) return undefined;
    return this.inTransition(instance, async () => {
      instance.metadata.enabled = false;
      instance.epoch++;
      this.persistEnabled(pluginName, false);
      instance.suspending = true;
      try {
        if (instance.started && instance.plugin.onShutdown) {
          await this.runner.runCleanup(pluginName, "onShutdown", () =>
            instance.plugin.onShutdown!("Plugin disabled"),
          );
        }
        instance.started = false;
        // Sweep whatever the shutdown left mounted.
        for (const deviceId of [...instance.devices.keys()]) {
          instance.devices.delete(deviceId);
          await this.onDeviceUnregistered?.(pluginName, deviceId, {
            keepIdentity: true,
          });
        }
      } finally {
        instance.suspending = false;
      }
      for (const [domain, owner] of this.domainMappingOwners) {
        if (owner === pluginName) {
          this.domainMappings.delete(domain);
          this.domainMappingOwners.delete(domain);
        }
      }
      return instance.metadata;
    });
  }

  /**
   * Enable a plugin, persist the choice, and start it right away so its
   * devices come back without a bridge restart. Returns the resulting
   * metadata, or undefined for an unknown name.
   */
  async enablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    const instance = this.instances.get(pluginName);
    if (!instance) return undefined;
    return this.inTransition(instance, async () => {
      this.runner.resetCircuitBreaker(pluginName);
      instance.metadata.enabled = true;
      this.persistEnabled(pluginName, true);
      if (instance.started) return instance.metadata;
      // A save parked during the disable becomes the config this start
      // reads, or the old config would mount first and the parked one
      // remount everything right behind it. Cleared only once persisted, so
      // a failed start cannot lose it.
      const pending = instance.pendingConfig;
      if (pending) {
        try {
          await instance.context.storage.set(PLUGIN_CONFIG_KEY, pending);
          await instance.context.storage.flush?.();
          instance.metadata.config = pending;
          instance.pendingConfig = undefined;
        } catch (e) {
          logger.warn(
            `Failed to persist the parked config for "${pluginName}", it stays parked:`,
            e,
          );
        }
      }
      logger.info(`Starting plugin: ${pluginName}`);
      const epoch = ++instance.epoch;
      await this.runner.run(pluginName, "onStart", () =>
        instance.plugin.onStart(instance.contextAt(epoch)),
      );
      if (this.runner.isDisabled(pluginName)) {
        instance.metadata.enabled = false;
        return instance.metadata;
      }
      if (this.runner.getState(pluginName).failures === 0) {
        instance.started = true;
      }
      if (instance.plugin.getCurrentConfig) {
        instance.metadata.config = instance.plugin.getCurrentConfig();
      }
      if (instance.started && instance.plugin.onConfigure) {
        await this.runner.run(pluginName, "onConfigure", () =>
          instance.plugin.onConfigure!(),
        );
      }
      return instance.metadata;
    });
  }

  private readEnabledState(): Record<string, boolean> {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
      }
    } catch (e) {
      logger.warn(`Failed to read the plugin state file:`, e);
    }
    return {};
  }

  private persistEnabled(pluginName: string, enabled: boolean): void {
    try {
      const state = this.readEnabledState();
      state[pluginName] = enabled;
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      logger.warn(
        `Failed to persist enabled=${enabled} for "${pluginName}":`,
        e,
      );
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
    return this.inTransition(instance, async () => {
      config = { ...config };
      // The listing redacts secret fields to the placeholder; a save carrying
      // it back means "keep what is stored", never store the placeholder
      // itself.
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
        if (!instance.metadata.enabled) {
          instance.pendingConfig = config;
          logger.info(
            `Plugin "${pluginName}" is disabled, the config applies on enable`,
          );
        } else {
          await this.runner.run(pluginName, "onConfigChanged", () =>
            instance.plugin.onConfigChanged!(config),
          );
        }
      }
      return true;
    });
  }
}
