import { BridgeStatus } from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import type { LoggerService } from "../../core/app/logger.js";
import { BridgeServerNode } from "../../matter/endpoints/bridge-server-node.js";
import {
  CAMERA_TCP_CONFIG,
  parseCameraList,
} from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import type {
  PluginConfigSchema,
  PluginMetadata,
} from "../../plugins/types.js";
import { BridgeBase } from "./bridge-base.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { EntityIsolationService } from "./entity-isolation-service.js";

export class Bridge extends BridgeBase<
  BridgeServerNode,
  BridgeEndpointManager
> {
  protected override get label() {
    return "Bridge";
  }

  get aggregator() {
    return this.endpointManager.root;
  }

  protected override topLevelEndpoints(): Endpoint[] {
    return [...this.aggregator.parts];
  }

  get pluginInfo() {
    return this.endpointManager.getPluginInfo();
  }

  async enablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.enablePlugin(pluginName);
  }

  async disablePlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.disablePlugin(pluginName);
  }

  async resetPlugin(pluginName: string): Promise<PluginMetadata | undefined> {
    return await this.endpointManager.resetPlugin(pluginName);
  }

  getPluginConfigSchema(pluginName: string): PluginConfigSchema | undefined {
    return this.endpointManager.getPluginConfigSchema(pluginName);
  }

  async updatePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.endpointManager.updatePluginConfig(
      pluginName,
      config,
    );
    // only when the save actually landed, else tcp state drifts from storage
    if (result && pluginName === "camera") {
      await this.applyCameraTcp(config);
    }
    return result;
  }

  // #419: cameras need Matter over TCP because the WebRTC offer exceeds the UDP
  // message size. Match the bridge listener to the saved camera list. Changing
  // network config takes effect on (re)start, so bounce the bridge if running.
  private async applyCameraTcp(config: Record<string, unknown>): Promise<void> {
    const want =
      parseCameraList(config.cameras).length > 0 ||
      !!this.dataProvider.featureFlags?.enableMatterTcp;
    const have = !!this.server.state.network.tcp;
    if (want === have) {
      return;
    }
    this.log.info(
      want
        ? "cameras configured, enabling matter over tcp (#419)"
        : "no cameras left, disabling matter over tcp (#419)",
    );
    const running = this.status.code === BridgeStatus.Running;
    if (running) {
      await this.stop();
    }
    try {
      await this.server.set({
        network: { tcp: want ? CAMERA_TCP_CONFIG : undefined },
      });
    } catch (e) {
      this.log.warn(
        "Could not apply tcp live, restart matterhub to apply it:",
        e,
      );
    }
    if (running) {
      await this.start();
    }
  }

  constructor(
    env: Environment,
    logger: LoggerService,
    dataProvider: BridgeDataProvider,
    endpointManager: BridgeEndpointManager,
    serverOptions?: {
      tcp?: { incoming: boolean; outgoing: boolean };
    },
  ) {
    super(
      logger.get(`Bridge / ${dataProvider.id}`),
      dataProvider,
      endpointManager,
      new BridgeServerNode(
        env,
        dataProvider,
        endpointManager.root,
        serverOptions,
      ),
      // rotation is opt-in on an aggregator bridge, one controller session
      // holds many devices
      0,
    );
    this.endpointManager.setTopologyChangeHandler(async (change) => {
      await this.server.act("topology change", (agent) =>
        agent.get(BasicInformationServer).increaseConfigurationVersion(change),
      );
      this.log.debugCtx("Matter topology configuration version increased", {
        configurationVersion: this.server.stateOf(BasicInformationServer)
          .configurationVersion,
      });
    });
    const { basicInformation } = this.dataProvider;
    this.log.debugCtx("Root bridge BasicInformation configured", {
      vendorName: basicInformation.vendorName,
      productName: basicInformation.productName,
      productLabel: basicInformation.productLabel,
      hardwareVersion: basicInformation.hardwareVersion,
      hardwareVersionString: basicInformation.hardwareVersionString,
      softwareVersion: basicInformation.softwareVersion,
      softwareVersionString: basicInformation.softwareVersionString,
    });
  }

  protected override async runStart(): Promise<void> {
    // every start recreates the endpoints, so an isolation from a previous
    // run must not keep showing the entity as failed
    EntityIsolationService.clearIsolatedEntities(this.id);
    await super.runStart();
  }

  // before the node goes online, or plugin devices miss the first PartsList
  // after every restart and controllers see them come back
  protected override async onServerStarting(): Promise<void> {
    await this.endpointManager.startPlugins();
  }

  protected override async onServerStopping(): Promise<void> {
    await this.endpointManager.stopPlugins();
  }
}
