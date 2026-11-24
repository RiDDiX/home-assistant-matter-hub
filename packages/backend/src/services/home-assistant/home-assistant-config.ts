import { Logger } from "@matter/general";
import type { HassConfig } from "home-assistant-js-websocket";
import { Service } from "../../core/ioc/service.js";
import { sendHaMessage } from "../../utils/send-ha-message.js";
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
    this.config = this.client.initialConfig;
    // A unit system change applies live in HA, setpoints and readings
    // converted with the old one would be off until a restart.
    const reload = () => {
      sendHaMessage<HassConfig>(
        connection,
        { type: "get_config" },
        this.client.messageTimeoutMs,
      )
        .then((config) => {
          this.config = config;
        })
        .catch((e) => logger.warn("Failed to reload HA config:", e));
    };
    connection.addEventListener("ready", reload);
    // A missing subscription acknowledgement must not prevent startup.
    void connection
      .subscribeEvents(reload, "core_config_updated")
      .catch((e) =>
        logger.warn("Cannot watch HA config, unit changes need a restart:", e),
      );
  }
}
