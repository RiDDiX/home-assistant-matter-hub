import type * as http from "node:http";
import express from "express";
import basicAuth from "express-basic-auth";
import AccessControl from "express-ip-access-control";
import nocache from "nocache";
import type { BetterLogger, LoggerService } from "../core/app/logger.js";
import { Service } from "../core/ioc/service.js";
import type { BackupService } from "../services/backup/backup-service.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { DiagnosticService } from "../services/diagnostics/diagnostic-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { StandaloneDeviceManager } from "../services/standalone-devices/standalone-device-manager.js";
import type { AppSettingsStorage } from "../services/storage/app-settings-storage.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import type { LockCredentialStorage } from "../services/storage/lock-credential-storage.js";
import { StandaloneDeviceStorage } from "../services/storage/standalone-device-storage.js";
import { accessLogger } from "./access-log.js";
import { backupApi } from "./backup-api.js";
import { bridgeExportApi } from "./bridge-export-api.js";
import { bridgeIconApi } from "./bridge-icon-api.js";
import { deviceImageApi } from "./device-image-api.js";
import { diagnosticApi } from "./diagnostic-api.js";
import { entityMappingApi } from "./entity-mapping-api.js";
import { healthApi } from "./health-api.js";
import { homeAssistantApi } from "./home-assistant-api.js";
import { lockCredentialApi } from "./lock-credential-api.js";
import { logsApi } from "./logs-api.js";
import { mappingProfileApi } from "./mapping-profile-api.js";
import { matterApi } from "./matter-api.js";
import { metricsApi } from "./metrics-api.js";
import { networkDiagnosticApi } from "./network-diagnostic-api.js";
import { pluginApi } from "./plugin-api.js";
import { supportIngress, supportProxyLocation } from "./proxy-support.js";
import { settingsApi } from "./settings-api.js";
import { standaloneDeviceApi } from "./standalone-device-api.js";
import { systemApi } from "./system-api.js";
import { webUi } from "./web-ui.js";
import { WebSocketApi } from "./websocket-api.js";

export interface WebApiProps {
  readonly port: number;
  readonly whitelist: string[] | undefined;
  readonly webUiDist?: string;
  readonly version: string;
  readonly storageLocation: string;
  readonly basePath: string;
  readonly auth?: {
    username: string;
    password: string;
  };
  readonly mdnsInterface?: string;
  readonly mdnsIpv4?: boolean;
}

export class WebApi extends Service {
  private standaloneDeviceManager!: StandaloneDeviceManager;
  private standaloneDeviceStorage!: StandaloneDeviceStorage;
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
    private readonly lockCredentialStorage: LockCredentialStorage,
    private readonly settingsStorage: AppSettingsStorage,
    private readonly backupService: BackupService,
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
    this.wsApi.setDiagnosticService(new DiagnosticService(bridgeService));
  }

  get websocket(): WebSocketApi {
    return this.wsApi;
  }

  protected override async initialize() {
    // Get StandaloneDeviceStorage from environment (assume DI or manual load)
    // If not available, throw error
    // Try to get StandaloneDeviceStorage from environment if available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const envObj = (this as unknown as { env: any }).env;
    this.standaloneDeviceStorage =
      this.standaloneDeviceStorage || envObj?.get?.(StandaloneDeviceStorage);
    if (!this.standaloneDeviceStorage) {
      throw new Error(
        "StandaloneDeviceStorage not available in WebApi environment",
      );
    }
    // Pass the correct Environment instance, not 'this' (WebApi)
    this.standaloneDeviceManager = new StandaloneDeviceManager(
      envObj,
      this.standaloneDeviceStorage,
    );
    await this.standaloneDeviceManager.initialize();

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
      .use("/bridge-icons", bridgeIconApi(this.props.storageLocation))
      .use(
        "/device-images",
        deviceImageApi(this.props.storageLocation, this.haRegistry),
      )
      .use("/entity-mappings", entityMappingApi(this.mappingStorage))
      .use("/mapping-profiles", mappingProfileApi(this.mappingStorage))
      .use(
        "/standalone-devices",
        standaloneDeviceApi(this.standaloneDeviceStorage),
      )
      .use("/lock-credentials", lockCredentialApi(this.lockCredentialStorage))
      .use("/settings", settingsApi(this.settingsStorage, this.props.auth))
      .use(
        "/backup",
        backupApi(
          this.bridgeStorage,
          this.mappingStorage,
          this.props.storageLocation,
          this.backupService,
          this.settingsStorage,
        ),
      )
      .use("/home-assistant", homeAssistantApi(this.haRegistry, this.haClient))
      .use("/logs", logsApi(this.logger))
      .use("/system", systemApi(this.props.version))
      .use(
        "/diagnostic",
        diagnosticApi(
          this.bridgeService,
          this.haClient,
          this.haRegistry,
          this.props.version,
          this.startTime,
        ),
      )
      .use(
        "/metrics",
        metricsApi(
          this.bridgeService,
          this.haClient,
          this.haRegistry,
          this.startTime,
        ),
      )
      .use(
        "/plugins",
        pluginApi(this.bridgeService, this.props.storageLocation),
      )
      .use(
        "/network",
        networkDiagnosticApi(
          this.props.mdnsInterface,
          this.props.mdnsIpv4 ?? true,
        ),
      );

    const middlewares: express.Handler[] = [
      this.accessLogger,
      supportIngress,
      supportProxyLocation,
    ];

    middlewares.push(this.createDynamicAuthMiddleware());
    if (this.props.auth) {
      this.log.info("Basic authentication enabled (environment variables)");
    } else if (this.settingsStorage.auth) {
      this.log.info("Basic authentication enabled (stored settings)");
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

    const appRouter = express.Router();
    appRouter
      .use(...middlewares)
      .use("/api", api)
      .use(webUi(this.props.webUiDist));

    this.app = express();
    const basePath = this.props.basePath;
    if (basePath !== "/") {
      this.log.info(`Base path configured: ${basePath}`);
      this.app.get("/", (_req, res) => res.redirect(basePath));
    }
    this.app.use(basePath, appRouter);
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

  private createDynamicAuthMiddleware(): express.RequestHandler {
    const envAuth = this.props.auth;
    const envMiddleware = envAuth
      ? basicAuth({
          users: { [envAuth.username]: envAuth.password },
          challenge: true,
          realm: "Home Assistant Matter Hub",
        })
      : undefined;
    const storageMiddleware = basicAuth({
      authorizer: (username: string, password: string) =>
        this.settingsStorage.verifyAuth(username, password),
      challenge: true,
      realm: "Home Assistant Matter Hub",
    });
    return (req, res, next) => {
      if (req.path === "/api/health/live" || req.path === "/api/health/ready") {
        return next();
      }
      if (envMiddleware) {
        return envMiddleware(req, res, next);
      }
      if (!this.settingsStorage.auth) {
        return next();
      }
      return storageMiddleware(req, res, next);
    };
  }

  async start() {
    if (this.server) {
      return;
    }
    this.server = await new Promise((resolve, reject) => {
      const server = this.app.listen(this.props.port, () => {
        this.log.info(
          `HTTP server (API ${this.props.webUiDist ? "& Web App" : "only"}) listening on port ${this.props.port}`,
        );
        resolve(server);
      });
      server.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`Port ${this.props.port} already in use`)
            : err,
        );
      });
    });
    this.wsApi.attach(this.server, this.props.basePath);
  }
}
