import { Logger } from "@matter/general";
import { getConfig, type HassConfig } from "home-assistant-js-websocket";
import { Service } from "../../core/ioc/service.js";
import type { HomeAssistantClient } from "./home-assistant-client.js";

const logger = Logger.get("HomeAssistantConfig");

export class HomeAssistantConfig extends Service {
  private config!: HassConfig;

  get unitSystem() {
    return this.config.unit_system;
  }

  constructor(private readonly client: HomeAssistantClient) {
    super("HomeAssistantConfig");
  }

  protected override async initialize() {
    const connection = this.client.connection;
    this.config = await getConfig(connection);
    // A unit system change applies live in HA, setpoints and readings
    // converted with the old one would be off until a restart.
    const reload = () => {
      getConfig(connection)
        .then((config) => {
          this.config = config;
        })
        .catch((e) => logger.warn("Failed to reload HA config:", e));
    };
    connection.addEventListener("ready", reload);
    await connection
      .subscribeEvents(reload, "core_config_updated")
      .catch((e) =>
        logger.warn("Cannot watch HA config, unit changes need a restart:", e),
      );
  }
}
