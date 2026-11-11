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
import type { AppSettingsStorage } from "../services/storage/app-settings-storage.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import type { LockCredentialStorage } from "../services/storage/lock-credential-storage.js";
import { accessLogger } from "./access-log.js";
import { backupApi } from "./backup-api.js";
import { bridgeExportApi } from "./bridge-export-api.js";
import { bridgeIconApi } from "./bridge-icon-api.js";
import { deviceImageApi } from "./device-image-api.js";
import { diagnosticApi } from "./diagnostic-api.js";
import { entityMappingApi } from "./entity-mapping-api.js";
import { healthApi } from "./health-api.js";
import { homeAssistantApi } from "./home-assistant-api.js";
import { hostGuard } from "./host-guard.js";
import { lockCredentialApi } from "./lock-credential-api.js";
import { logsApi } from "./logs-api.js";
import { mappingProfileApi } from "./mapping-profile-api.js";
import { matterApi } from "./matter-api.js";
import { metricsApi } from "./metrics-api.js";
import { networkDiagnosticApi } from "./network-diagnostic-api.js";
import { pluginApi } from "./plugin-api.js";
import { supportIngress, supportProxyLocation } from "./proxy-support.js";
import { settingsApi } from "./settings-api.js";
import { systemApi } from "./system-api.js";
import { webUi } from "./web-ui.js";
import { WebSocketApi } from "./websocket-api.js";

const healthProbePaths = new Set(["/api/health/live", "/api/health/ready"]);

export function isLoopback(remoteAddress: string | undefined): boolean {
  return AccessControl.ipMatch(remoteAddress ?? "", ["127.0.0.0/8", "::1"]);
}

export interface WebApiProps {
  readonly port: number;
  readonly whitelist: string[] | undefined;
  readonly allowedHosts: string[];
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
    private readonly identityStorage: EntityIdentityStorage,
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
    const api = express.Router();
    api
      .use(express.json())
      .use(nocache())
      .use(
        "/matter",
        matterApi(
          this.bridgeService,
          this.haRegistry,
          this.identityStorage,
          this.mappingStorage,
          this.props.storageLocation,
        ),
      )
      .use(
        "/health",
        healthApi(
          this.bridgeService,
          this.haClient,
          this.props.version,
          this.startTime,
        ),
      )
      .use("/bridges", bridgeExportApi(this.bridgeStorage, this.bridgeService))
      .use("/bridge-icons", bridgeIconApi(this.props.storageLocation))
      .use(
        "/device-images",
        deviceImageApi(this.props.storageLocation, this.haRegistry),
      )
      .use(
        "/entity-mappings",
        entityMappingApi(this.mappingStorage, this.identityStorage),
      )
      .use("/mapping-profiles", mappingProfileApi(this.mappingStorage))
      .use(
        "/lock-credentials",
        lockCredentialApi(this.lockCredentialStorage, (entityId) =>
          this.bridgeStorage.bridges.flatMap(
            (b) => this.mappingStorage.getMapping(b.id, entityId) ?? [],
          ),
        ),
      )
      .use(
        "/settings",
        settingsApi(this.settingsStorage, this.bridgeService, this.props.auth),
      )
      .use(
        "/backup",
        backupApi(
          this.bridgeStorage,
          this.mappingStorage,
          this.props.storageLocation,
          this.backupService,
          this.settingsStorage,
          this.bridgeService,
          this.identityStorage,
        ),
      )
      .use("/home-assistant", homeAssistantApi(this.haRegistry, this.haClient))
      .use("/logs", logsApi(this.logger))
      .use("/system", systemApi(this.props.version, this.props.storageLocation))
      .use(
        "/diagnostic",
        diagnosticApi(
          this.bridgeService,
          this.haClient,
          this.haRegistry,
          this.props.version,
          this.startTime,
          this.logger,
          this.props.mdnsInterface,
          this.props.mdnsIpv4 ?? true,
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
      hostGuard(this.props.allowedHosts),
      supportIngress,
      supportProxyLocation,
    ];

    // Whitelist first, so denied clients never get an auth challenge.
    if (this.props.whitelist && this.props.whitelist.length > 0) {
      const whitelist = AccessControl({
        log: (clientIp, access) => {
          this.log.silly(
            `Client ${clientIp} was ${access ? "granted" : "denied"}`,
          );
        },
        mode: "allow",
        allows: this.props.whitelist,
        statusCode: "403",
        message: "Forbidden",
      });
      // The container healthcheck probes from loopback.
      middlewares.push((req, res, next) =>
        healthProbePaths.has(req.path) && isLoopback(req.socket.remoteAddress)
          ? next()
          : whitelist(req, res, next),
      );
    }
    middlewares.push(this.createDynamicAuthMiddleware());
    if (this.props.auth) {
      this.log.info("Basic authentication enabled (environment variables)");
    } else if (this.settingsStorage.auth) {
      this.log.info("Basic authentication enabled (stored settings)");
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
    // Express' default handler answers with the stack trace outside production.
    this.app.use(((err, req, res, next) => {
      if (res.headersSent) {
        return next(err);
      }
      const code = Number(err?.status ?? err?.statusCode);
      const status = code >= 400 && code < 500 ? code : 500;
      if (status === 500) {
        this.log.error(`${req.method} ${req.originalUrl} failed:`, err);
      }
      const exposed = status < 500 && err?.expose === true;
      res.status(status).json({
        error: exposed
          ? String(err.message)
          : status < 500
            ? "Bad request"
            : "Internal server error",
      });
    }) as express.ErrorRequestHandler);
  }

  override async dispose() {
    this.wsApi.close();
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      // Log streams never end on their own.
      server.closeAllConnections();
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
      authorizer: (
        username: string,
        password: string,
        callback: basicAuth.AsyncAuthorizerCallback,
      ) => {
        // express-basic-auth throws on a callback error, so deny instead.
        this.settingsStorage.verifyAuth(username, password).then(
          (ok) => callback(null, ok),
          () => callback(null, false),
        );
      },
      authorizeAsync: true,
      challenge: true,
      realm: "Home Assistant Matter Hub",
    });
    return (req, res, next) => {
      if (healthProbePaths.has(req.path)) {
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

  // Same credentials as the http middleware, for upgrades that skip Express.
  private verifyAuthorization(
    header: string | undefined,
  ): Promise<boolean> | boolean {
    const envAuth = this.props.auth;
    if (!envAuth && !this.settingsStorage.auth) {
      return true;
    }
    const match = /^Basic (.+)$/i.exec(header ?? "");
    if (!match) {
      return false;
    }
    const decoded = Buffer.from(match[1], "base64").toString();
    const split = decoded.indexOf(":");
    if (split < 0) {
      return false;
    }
    const username = decoded.slice(0, split);
    const password = decoded.slice(split + 1);
    if (envAuth) {
      // Both compares always run, like express-basic-auth.
      const userOk = basicAuth.safeCompare(username, envAuth.username);
      const passwordOk = basicAuth.safeCompare(password, envAuth.password);
      return userOk && passwordOk;
    }
    return this.settingsStorage
      .verifyAuth(username, password)
      .catch(() => false);
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
    this.wsApi.attach(
      this.server,
      this.props.basePath,
      this.props.whitelist,
      this.props.allowedHosts,
      (header) => this.verifyAuthorization(header),
    );
  }
}
