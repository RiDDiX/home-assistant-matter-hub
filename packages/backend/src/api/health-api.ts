import express from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    homeAssistant: {
      connected: boolean;
    };
    bridges: {
      total: number;
      running: number;
      stopped: number;
    };
  };
}

export function healthApi(
  bridgeService: BridgeService,
  haClient: HomeAssistantClient,
  version: string,
  startTime: number,
): express.Router {
  const router = express.Router();

  router.get("/", (_, res) => {
    const bridges = bridgeService.bridges;
    const runningBridges = bridges.filter(
      (b) => b.data.status === "running",
    ).length;
    const stoppedBridges = bridges.filter(
      (b) => b.data.status === "stopped",
    ).length;
    const haConnected = haClient.connection?.connected ?? false;

    const isHealthy = haConnected && stoppedBridges === 0;
    const isDegraded = haConnected && stoppedBridges > 0;

    const health: HealthStatus = {
      status: isHealthy ? "healthy" : isDegraded ? "degraded" : "unhealthy",
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        homeAssistant: {
          connected: haConnected,
        },
        bridges: {
          total: bridges.length,
          running: runningBridges,
          stopped: stoppedBridges,
        },
      },
    };

    const statusCode =
      health.status === "healthy"
        ? 200
        : health.status === "degraded"
          ? 200
          : 503;
    res.status(statusCode).json(health);
  });

  router.get("/live", (_, res) => {
    res.status(200).send("OK");
  });

  router.get("/ready", (_, res) => {
    const haConnected = haClient.connection?.connected ?? false;
    if (haConnected) {
      res.status(200).send("OK");
    } else {
      res.status(503).send("Not Ready");
    }
  });

  return router;
}
