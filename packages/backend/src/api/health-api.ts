import express from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";

export interface BridgeHealthInfo {
  id: string;
  name: string;
  status: string;
  statusReason?: string;
  port: number;
  deviceCount: number;
  fabricCount: number;
  fabrics: Array<{
    fabricIndex: number;
    label: string;
    rootVendorId: number;
  }>;
  failedEntityCount: number;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    bridges: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
    };
  };
}

export interface DetailedHealthStatus extends HealthStatus {
  bridgeDetails: BridgeHealthInfo[];
  recovery: {
    enabled: boolean;
    lastRecoveryAttempt?: string;
    recoveryCount: number;
  };
}

export function healthApi(
  bridgeService: BridgeService,
  version: string,
  startTime: number,
): express.Router {
  const router = express.Router();

  const getBridgeStats = () => {
    const bridges = bridgeService.bridges;
    return {
      bridges,
      running: bridges.filter((b) => b.data.status === "running").length,
      stopped: bridges.filter((b) => b.data.status === "stopped").length,
      failed: bridges.filter((b) => b.data.status === "failed").length,
    };
  };

  const buildHealthStatus = (): HealthStatus => {
    const { bridges, running, stopped, failed } = getBridgeStats();
    const isHealthy = stopped === 0 && failed === 0;
    const isDegraded = stopped > 0 || failed > 0;

    return {
      status: isHealthy ? "healthy" : isDegraded ? "degraded" : "unhealthy",
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        bridges: {
          total: bridges.length,
          running,
          stopped,
          failed,
        },
      },
    };
  };

  router.get("/", (_, res) => {
    const health = buildHealthStatus();
    const statusCode = health.status === "unhealthy" ? 503 : 200;
    res.status(statusCode).json(health);
  });

  router.get("/detailed", (_, res) => {
    const health = buildHealthStatus();
    const { bridges } = getBridgeStats();

    const bridgeDetails: BridgeHealthInfo[] = bridges.map((b) => {
      const data = b.data;
      const fabrics = data.commissioning?.fabrics ?? [];
      return {
        id: data.id,
        name: data.name,
        status: data.status,
        statusReason: data.statusReason,
        port: data.port,
        deviceCount: data.deviceCount,
        fabricCount: fabrics.length,
        fabrics: fabrics.map((f) => ({
          fabricIndex: f.fabricIndex,
          label: f.label,
          rootVendorId: f.rootVendorId,
        })),
        failedEntityCount: data.failedEntities?.length ?? 0,
      };
    });

    const detailed: DetailedHealthStatus = {
      ...health,
      bridgeDetails,
      recovery: {
        enabled: bridgeService.autoRecoveryEnabled,
        lastRecoveryAttempt: bridgeService.lastRecoveryAttempt?.toISOString(),
        recoveryCount: bridgeService.recoveryCount,
      },
    };
    res.json(detailed);
  });

  router.get("/live", (_, res) => {
    res.status(200).send("OK");
  });

  router.get("/ready", (_, res) => {
    const { running, stopped } = getBridgeStats();
    if (running > 0 || stopped === 0) {
      res.status(200).send("OK");
    } else {
      res.status(503).send("Not Ready");
    }
  });

  return router;
}
