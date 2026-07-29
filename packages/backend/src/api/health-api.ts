import {
  buildEntityDiagnostics,
  type ControllerWarning,
  type EntityDiagnostic,
} from "@home-assistant-matter-hub/common";
import express from "express";
import type {
  BridgeService,
  RecoveryAttempt,
} from "../services/bridges/bridge-service.js";
import type { SubscriptionSummary } from "../services/bridges/subscription-summary.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";

export interface SessionInfo {
  id: number;
  peerNodeId: string;
  fabricIndex: number | null;
  subscriptionCount: number;
  // Scope of each active subscription on the session (whole-node wildcard vs
  // endpoint-specific), so the health view can show what the controller watches.
  subscriptions: SubscriptionSummary[];
  // #365 diagnostics: tell a healthy session from a wedged one. lastActiveMsAgo
  // is ms since the controller last sent us anything (resets on each keepalive
  // ack); lastAnyActivityMsAgo is ms since any traffic in either direction.
  lastActiveMsAgo: number | null;
  lastAnyActivityMsAgo: number | null;
  // ms since the last inbound Interaction Model request on this session, or null
  // if none was seen. Unlike lastActiveMsAgo this does not advance on MRP acks,
  // so it tells a healthy session from one wedged on "Updating".
  lastImRequestMsAgo: number | null;
  isPeerActive: boolean;
  ageMsFromOpen: number | null;
}

export interface FabricSessionSummary {
  fabricIndex: number;
  sessions: number;
  subscriptions: number;
}

export interface BridgeHealthInfo {
  id: string;
  name: string;
  status: string;
  statusReason?: string;
  port: number;
  priority: number;
  deviceCount: number;
  fabricCount: number;
  fabrics: Array<{
    fabricIndex: number;
    fabricId: number;
    nodeId: number;
    rootNodeId: number;
    label: string;
    rootVendorId: number;
  }>;
  failedEntityCount: number;
  // Advisory: exposed device types a commissioned controller does not support.
  controllerWarnings: ControllerWarning[];
  // Per-entity health roll-up: failed (with reason), limited, or ok.
  entityDiagnostics: EntityDiagnostic[];
  connectivity: {
    totalSessions: number;
    totalSubscriptions: number;
    sessions: SessionInfo[];
    fabricSummary: FabricSessionSummary[];
  };
}

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
    history: RecoveryAttempt[];
  };
}

export function healthApi(
  bridgeService: BridgeService,
  haClient: HomeAssistantClient,
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
    const haConnected = haClient.connection?.connected ?? false;
    const isHealthy = haConnected && stopped === 0 && failed === 0;
    const isDegraded = haConnected && (stopped > 0 || failed > 0);

    return {
      status: isHealthy ? "healthy" : isDegraded ? "degraded" : "unhealthy",
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      services: {
        homeAssistant: { connected: haConnected },
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
      const sessionInfo = b.getSessionInfo();
      const exposed = b.getExposedDeviceTypes();
      const controllerWarnings = data.controllerWarnings ?? [];
      const entityDiagnostics = buildEntityDiagnostics(
        exposed,
        data.failedEntities ?? [],
        controllerWarnings,
      );
      return {
        id: data.id,
        name: data.name,
        status: data.status,
        statusReason: data.statusReason,
        port: data.port,
        priority: data.priority ?? 100,
        deviceCount: data.deviceCount,
        fabricCount: fabrics.length,
        fabrics: fabrics.map((f) => ({
          fabricIndex: f.fabricIndex,
          fabricId: f.fabricId,
          nodeId: f.nodeId,
          rootNodeId: f.rootNodeId,
          label: f.label,
          rootVendorId: f.rootVendorId,
        })),
        failedEntityCount: data.failedEntities?.length ?? 0,
        controllerWarnings,
        entityDiagnostics,
        connectivity: {
          totalSessions: sessionInfo.totalSessions,
          totalSubscriptions: sessionInfo.totalSubscriptions,
          sessions: sessionInfo.sessions,
          fabricSummary: sessionInfo.fabrics,
        },
      };
    });

    const detailed: DetailedHealthStatus = {
      ...health,
      bridgeDetails,
      recovery: {
        enabled: bridgeService.autoRecoveryEnabled,
        lastRecoveryAttempt: bridgeService.lastRecoveryAttempt?.toISOString(),
        recoveryCount: bridgeService.recoveryCount,
        history: bridgeService.recoveryHistory,
      },
    };
    res.json(detailed);
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
