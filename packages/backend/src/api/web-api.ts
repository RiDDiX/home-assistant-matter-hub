import type * as http from "node:http";
import express from "express";
import basicAuth from "express-basic-auth";
import AccessControl from "express-ip-access-control";
import nocache from "nocache";
import type { BetterLogger, LoggerService } from "../core/app/logger.js";
import { Service } from "../core/ioc/service.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import { accessLogger } from "./access-log.js";
import { backupApi } from "./backup-api.js";
import { bridgeExportApi } from "./bridge-export-api.js";
import { entityMappingApi } from "./entity-mapping-api.js";
import { healthApi } from "./health-api.js";
import { homeAssistantApi } from "./home-assistant-api.js";
import { logsApi } from "./logs-api.js";
import { matterApi } from "./matter-api.js";
import { metricsApi } from "./metrics-api.js";
import { supportIngress, supportProxyLocation } from "./proxy-support.js";
import { systemApi } from "./system-api.js";
import { webUi } from "./web-ui.js";
import { WebSocketApi } from "./websocket-api.js";

export interface WebApiProps {
  readonly port: number;
  readonly whitelist: string[] | undefined;
  readonly webUiDist?: string;
  readonly version: string;
  readonly storageLocation: string;
  readonly auth?: {
    username: string;
    password: string;
  };
}

export class WebApi extends Service {
  private readonly log: BetterLogger;
  private readonly logger: LoggerService;
  private readonly accessLogger: express.RequestHandler;
  private readonly startTime: number;
  private readonly wsApi: WebSocketApi;

  private app!: express.Application;
  private server?: http.Server;

  constructor(
    logger: LoggerService,
    private readonly bridgeService: BridgeService,
    private readonly haClient: HomeAssistantClient,
    private readonly haRegistry: HomeAssistantRegistry,
    private readonly bridgeStorage: BridgeStorage,
    private readonly mappingStorage: EntityMappingStorage,
    private readonly props: WebApiProps,
  ) {
    super("WebApi");
    this.logger = logger;
    this.log = logger.get(this);
    this.accessLogger = accessLogger(this.log.createChild("Access Log"));
    this.startTime = Date.now();
    this.wsApi = new WebSocketApi(
      this.log.createChild("WebSocket"),
      bridgeService,
    );
  }

  get websocket(): WebSocketApi {
    return this.wsApi;
  }

  protected override async initialize() {
    const api = express.Router();
    api
      .use(express.json())
      .use(nocache())
      .use("/matter", matterApi(this.bridgeService, this.haRegistry))
      .use(
        "/health",
        healthApi(
          this.bridgeService,
          this.haClient,
          this.props.version,
          this.startTime,
        ),
      )
      .use("/bridges", bridgeExportApi(this.bridgeStorage))
      .use("/entity-mappings", entityMappingApi(this.mappingStorage))
      .use(
        "/backup",
        backupApi(
          this.bridgeStorage,
          this.mappingStorage,
          this.props.storageLocation,
        ),
      )
      .use("/home-assistant", homeAssistantApi(this.haRegistry, this.haClient))
      .use("/logs", logsApi(this.logger))
      .use("/system", systemApi())
      .use(
        "/metrics",
        metricsApi(
          this.bridgeService,
          this.haClient,
          this.haRegistry,
          this.startTime,
        ),
      );

    const middlewares: express.Handler[] = [
      this.accessLogger,
      supportIngress,
      supportProxyLocation,
    ];

    if (this.props.auth) {
      middlewares.push(
        basicAuth({
          users: { [this.props.auth.username]: this.props.auth.password },
          challenge: true,
          realm: "Home Assistant Matter Hub",
        }),
      );
      this.log.info("Basic authentication enabled");
    }
    if (this.props.whitelist && this.props.whitelist.length > 0) {
      middlewares.push(
        AccessControl({
          log: (clientIp, access) => {
            this.log.silly(
              `Client ${clientIp} was ${access ? "granted" : "denied"}`,
            );
          },
          mode: "allow",
          allows: this.props.whitelist,
        }),
      );
    }

    this.app = express()
      .use(...middlewares)
      .use("/api", api)
      .use(webUi(this.props.webUiDist));
  }

  override async dispose() {
    this.wsApi.close();
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async start() {
    if (this.server) {
      return;
    }
    this.server = await new Promise((resolve) => {
      const server = this.app.listen(this.props.port, () => {
        this.log.info(
          `HTTP server (API ${this.props.webUiDist ? "& Web App" : "only"}) listening on port ${this.props.port}`,
        );
        resolve(server);
      });
    });
    this.wsApi.attach(this.server);
  }
}
