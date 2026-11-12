import type * as http from "node:http";
import type { WebSocketMessage } from "@home-assistant-matter-hub/common";
import AccessControl from "express-ip-access-control";
import { type WebSocket, WebSocketServer } from "ws";
import type { BetterLogger } from "../core/app/logger.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { diagnosticEventBus } from "../services/diagnostics/diagnostic-event-bus.js";
import type { DiagnosticService } from "../services/diagnostics/diagnostic-service.js";
import { crossSiteMessage, crossSiteReason } from "./host-guard.js";

export class WebSocketApi {
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private diagnosticSubscribers: Set<WebSocket> = new Set();
  private pingInterval?: ReturnType<typeof setInterval>;
  private unsubscribeDiagnostics?: () => void;
  private diagnosticService?: DiagnosticService;

  constructor(
    private readonly log: BetterLogger,
    private readonly bridgeService: BridgeService,
  ) {}

  setDiagnosticService(service: DiagnosticService) {
    this.diagnosticService = service;
  }

  attach(
    server: http.Server,
    basePath = "/",
    whitelist?: string[],
    allowedHosts: string[] = [],
    verifyAuthorization: (
      header: string | undefined,
    ) => Promise<boolean> | boolean = () => true,
  ) {
    const wsPath = `${basePath === "/" ? "" : basePath}/api/ws`;
    this.wss = new WebSocketServer({
      server,
      path: wsPath,
      // Clients only send small control messages.
      maxPayload: 64 * 1024,
      // Upgrades skip the Express middlewares, so apply the same checks here.
      verifyClient: ({ req }, cb) => {
        if (
          whitelist?.length &&
          !AccessControl.ipMatch(req.socket.remoteAddress ?? "", whitelist)
        ) {
          return cb(false, 403);
        }
        const reason = crossSiteReason(
          req.headers,
          allowedHosts,
          req.socket.remoteAddress,
        );
        if (reason) {
          // ws defaults the body to text/html.
          return cb(false, 403, crossSiteMessage(reason, req.headers), {
            "Content-Type": "text/plain; charset=utf-8",
          });
        }
        Promise.resolve()
          .then(() => verifyAuthorization(req.headers.authorization))
          .then(
            (ok) =>
              ok
                ? cb(true)
                : cb(false, 401, "Unauthorized", {
                    "WWW-Authenticate":
                      'Basic realm="Home Assistant Matter Hub"',
                  }),
            () => cb(false, 401),
          );
      },
    });
    // A proxy that keeps its x-forwarded-prefix in the URL sends /<prefix>/api/ws.
    this.wss.shouldHandle = (req) =>
      (req.url ?? "").split("?")[0].endsWith(wsPath);

    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.log.debug(`WebSocket client connected. Total: ${this.clients.size}`);

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage;
          this.handleMessage(ws, message);
        } catch {
          this.log.warn("Invalid WebSocket message received");
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.diagnosticSubscribers.delete(ws);
        this.log.debug(
          `WebSocket client disconnected. Total: ${this.clients.size}`,
        );
      });

      ws.on("error", (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.clients.delete(ws);
        this.diagnosticSubscribers.delete(ws);
      });

      this.sendInitialState(ws);
    });

    this.unsubscribeDiagnostics = diagnosticEventBus.subscribe((event) => {
      const msg: WebSocketMessage = {
        type: "diagnostic_event",
        data: event,
      };
      const payload = JSON.stringify(msg);
      for (const client of this.diagnosticSubscribers) {
        if (client.readyState === client.OPEN) {
          client.send(payload);
        }
      }
    });

    this.pingInterval = setInterval(() => {
      this.broadcast({ type: "ping" });
    }, 30000);

    this.log.info(`WebSocket server attached at ${wsPath}`);
  }

  private handleMessage(ws: WebSocket, message: WebSocketMessage) {
    switch (message.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "pong":
        break;
      case "subscribe_diagnostics":
        this.diagnosticSubscribers.add(ws);
        if (this.diagnosticService) {
          const snapshot = this.diagnosticService.getSnapshot();
          ws.send(
            JSON.stringify({
              type: "diagnostic_snapshot",
              data: snapshot,
            } satisfies WebSocketMessage),
          );
        }
        break;
      case "unsubscribe_diagnostics":
        this.diagnosticSubscribers.delete(ws);
        break;
      default:
        this.log.debug(`Unknown message type: ${message.type}`);
    }
  }

  private sendInitialState(ws: WebSocket) {
    const bridges = this.bridgeService.bridges.map((b) => b.data);
    const msg: WebSocketMessage = {
      type: "bridges_update",
      data: bridges,
    };
    ws.send(JSON.stringify(msg));
  }

  broadcastBridgesUpdate() {
    const bridges = this.bridgeService.bridges.map((b) => b.data);
    this.broadcast({ type: "bridges_update", data: bridges });
  }

  broadcastBridgeUpdate(bridgeId: string) {
    const bridge = this.bridgeService.get(bridgeId);
    if (bridge) {
      this.broadcast({
        type: "bridge_update",
        bridgeId,
        data: bridge.data,
      });
    } else {
      // Deleted bridges are gone from the service, so send the whole list.
      this.broadcastBridgesUpdate();
    }
  }

  private broadcast(message: WebSocketMessage) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  // Auth runs only at the upgrade, so clients must reconnect to be checked again.
  disconnectAll() {
    for (const client of this.wss?.clients ?? []) {
      client.terminate();
    }
  }

  close() {
    this.unsubscribeDiagnostics?.();
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    // ws 8 leaves open clients running, which keeps the http server open.
    this.disconnectAll();
    this.wss?.close();
    this.clients.clear();
    this.diagnosticSubscribers.clear();
  }
}
