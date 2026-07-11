import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { Environment, Logger } from "@matter/general";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { PluginInstaller } from "../../plugins/plugin-installer.js";
import { PluginManager } from "../../plugins/plugin-manager.js";
import { PluginRegistry } from "../../plugins/plugin-registry.js";
import { Bridge } from "../../services/bridges/bridge.js";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { BridgeEndpointManager } from "../../services/bridges/bridge-endpoint-manager.js";
import { BridgeFactory } from "../../services/bridges/bridge-factory.js";
import { BridgeRegistry } from "../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { ServerModeBridge } from "../../services/bridges/server-mode-bridge.js";
import { ServerModeEndpointManager } from "../../services/bridges/server-mode-endpoint-manager.js";
import { HomeAssistantClient } from "../../services/home-assistant/home-assistant-client.js";
import { HomeAssistantRegistry } from "../../services/home-assistant/home-assistant-registry.js";
import { EntityMappingStorage } from "../../services/storage/entity-mapping-storage.js";
import { LoggerService } from "../app/logger.js";
import type { AppEnvironment } from "./app-environment.js";
import { EnvironmentBase } from "./environment-base.js";

export class BridgeEnvironment extends EnvironmentBase {
  static async create(
    parent: Environment,
    initialData: BridgeData,
    storageLocation?: string,
  ) {
    const bridge = new BridgeEnvironment(parent, initialData, storageLocation);
    await bridge.construction;
    return bridge;
  }

  private readonly construction: Promise<void>;
  private readonly endpointManagerLogger: Logger;
  private readonly storageLocation?: string;

  private constructor(
    parent: Environment,
    initialData: BridgeData,
    storageLocation?: string,
  ) {
    const loggerService = parent.get(LoggerService);
    const log = loggerService.get(`BridgeEnvironment / ${initialData.id}`);

    super({ id: initialData.id, parent, log });
    this.endpointManagerLogger = loggerService.get("BridgeEndpointManager");
    this.storageLocation = storageLocation;
    this.construction = this.init();

    this.set(BridgeDataProvider, new BridgeDataProvider(initialData));
  }

  private async init() {
    const haRegistry = await this.load(HomeAssistantRegistry);
    const haClient = await this.load(HomeAssistantClient);

    this.set(
      BridgeRegistry,
      new BridgeRegistry(haRegistry, this.get(BridgeDataProvider), haClient),
    );
    this.set(EntityStateProvider, new EntityStateProvider(haRegistry));

    const bridgeId = this.get(BridgeDataProvider).id;
    let pluginManager: PluginManager | undefined;
    let pluginRegistry: PluginRegistry | undefined;
    let pluginInstaller: PluginInstaller | undefined;
    if (this.storageLocation) {
      pluginManager = new PluginManager(bridgeId, this.storageLocation, {
        url: haClient.baseUrl,
        accessToken: haClient.accessToken,
      });
      pluginRegistry = new PluginRegistry(this.storageLocation);
      pluginManager.setRegistry(pluginRegistry);
      pluginInstaller = new PluginInstaller(this.storageLocation);
    }

    this.set(
      BridgeEndpointManager,
      new BridgeEndpointManager(
        await this.load(HomeAssistantClient),
        this.get(BridgeRegistry),
        await this.load(EntityMappingStorage),
        bridgeId,
        this.endpointManagerLogger,
        pluginManager,
        pluginRegistry,
        pluginInstaller,
      ),
    );
  }
}

/**
 * ServerModeEnvironment is a lightweight environment for server mode bridges.
 * It does NOT create a BridgeEndpointManager since server mode uses
 * ServerModeEndpointManager instead.
 */
export class ServerModeEnvironment extends EnvironmentBase {
  static async create(parent: Environment, initialData: BridgeData) {
    const env = new ServerModeEnvironment(parent, initialData);
    await env.construction;
    return env;
  }

  private readonly construction: Promise<void>;

  private constructor(parent: Environment, initialData: BridgeData) {
    const loggerService = parent.get(LoggerService);
    const log = loggerService.get(`ServerModeEnvironment / ${initialData.id}`);

    super({ id: initialData.id, parent, log });
    this.construction = this.init();

    this.set(BridgeDataProvider, new BridgeDataProvider(initialData));
  }

  private async init() {
    const haRegistry = await this.load(HomeAssistantRegistry);
    const haClient = await this.load(HomeAssistantClient);

    this.set(
      BridgeRegistry,
      new BridgeRegistry(haRegistry, this.get(BridgeDataProvider), haClient),
    );
    this.set(EntityStateProvider, new EntityStateProvider(haRegistry));
    // Note: No BridgeEndpointManager - server mode uses ServerModeEndpointManager
  }
}

export class BridgeEnvironmentFactory extends BridgeFactory {
  constructor(
    private readonly parent: AppEnvironment,
    private readonly storageLocation?: string,
  ) {
    super("BridgeEnvironmentFactory");
  }

  async create(initialData: BridgeData): Promise<Bridge> {
    const isServerMode = initialData.featureFlags?.serverMode === true;

    if (isServerMode) {
      return this.createServerModeBridge(initialData);
    }

    return this.createNormalBridge(initialData);
  }

  private async createNormalBridge(initialData: BridgeData): Promise<Bridge> {
    const env = await BridgeEnvironment.create(
      this.parent,
      initialData,
      this.storageLocation,
    );

    class BridgeWithEnvironment extends Bridge {
      override async dispose(): Promise<void> {
        await super.dispose();
        await env.dispose();
      }
    }

    const bridge = new BridgeWithEnvironment(
      env,
      env.get(LoggerService),
      await env.load(BridgeDataProvider),
      await env.load(BridgeEndpointManager),
    );
    await bridge.initialize();
    return bridge;
  }

  private async createServerModeBridge(
    initialData: BridgeData,
  ): Promise<Bridge> {
    // Use ServerModeEnvironment which doesn't create BridgeEndpointManager
    const env = await ServerModeEnvironment.create(this.parent, initialData);
    const loggerService = env.get(LoggerService);
    const dataProvider = await env.load(BridgeDataProvider);

    // Create server mode specific components
    const serverNode = new ServerModeServerNode(env, dataProvider);

    const endpointManager = new ServerModeEndpointManager(
      serverNode,
      await env.load(HomeAssistantClient),
      env.get(BridgeRegistry),
      await env.load(EntityMappingStorage),
      dataProvider,
      loggerService.get("ServerModeEndpointManager"),
    );

    // Return as Bridge type (ServerModeBridge has compatible interface)
    class ServerModeBridgeWithEnvironment
      extends ServerModeBridge
      implements Pick<Bridge, "id" | "data" | "aggregator">
    {
      get aggregator() {
        // Server mode doesn't have an aggregator, return undefined cast
        return undefined as unknown as Bridge["aggregator"];
      }

      override async dispose(): Promise<void> {
        await super.dispose();
        await env.dispose();
      }
    }

    const bridge = new ServerModeBridgeWithEnvironment(
      loggerService,
      dataProvider,
      endpointManager,
      serverNode,
    );
    await bridge.initialize();

    // Cast to Bridge - the interfaces are compatible for BridgeService usage
    return bridge as unknown as Bridge;
  }
}
