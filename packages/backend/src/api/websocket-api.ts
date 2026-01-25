import type * as http from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { BetterLogger } from "../core/app/logger.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";

export interface WebSocketMessage {
  type: "bridges_update" | "bridge_update" | "ping" | "pong";
  data?: unknown;
  bridgeId?: string;
}

export class WebSocketApi {
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private pingInterval?: ReturnType<typeof setInterval>;

  constructor(
    private readonly log: BetterLogger,
    private readonly bridgeService: BridgeService,
  ) {}

  attach(server: http.Server) {
    this.wss = new WebSocketServer({ server, path: "/api/ws" });

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
        this.log.debug(
          `WebSocket client disconnected. Total: ${this.clients.size}`,
        );
      });

      ws.on("error", (error) => {
        this.log.error(`WebSocket error: ${error.message}`);
        this.clients.delete(ws);
      });

      this.sendInitialState(ws);
    });

    this.pingInterval = setInterval(() => {
      this.broadcast({ type: "ping" });
    }, 30000);

    this.log.info("WebSocket server attached at /api/ws");
  }

  private handleMessage(ws: WebSocket, message: WebSocketMessage) {
    switch (message.type) {
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      case "pong":
        break;
      default:
        this.log.debug(`Unknown message type: ${message.type}`);
    }
  }

  private sendInitialState(ws: WebSocket) {
    const bridges = this.bridgeService.bridges.map((b) => b.data);
    const message: WebSocketMessage = {
      type: "bridges_update",
      data: bridges,
    };
    ws.send(JSON.stringify(message));
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

  close() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.wss?.close();
    this.clients.clear();
  }
}
