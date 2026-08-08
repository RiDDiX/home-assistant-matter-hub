import os from "node:os";
import type { Endpoint } from "@matter/main";
import express from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { type LogEntry, logBuffer } from "./logs-api.js";

interface DiagnosticReport {
  generatedAt: string;
  version: string;
  uptime: number;
  system: {
    platform: string;
    arch: string;
    nodeVersion: string;
    environment: string;
    memory: {
      totalMB: number;
      freeMB: number;
      heapUsedMB: number;
      heapTotalMB: number;
      rssMB: number;
    };
  };
  homeAssistant: {
    connected: boolean;
    entityCount: number;
    deviceCount: number;
  };
  bridges: Array<{
    id: string;
    name: string;
    status: string;
    statusReason?: string;
    port: number;
    deviceCount: number;
    serverMode: boolean;
    featureFlags: Record<string, unknown>;
    commissioning: {
      commissioned: boolean;
      fabricCount: number;
      fabrics: Array<{
        fabricIndex: number;
        label: string;
        rootVendorId: number;
      }>;
    };
    failedEntities: Array<{
      entityId: string;
      reason: string;
    }>;
    endpointTree?: DiagnosticEndpointNode;
  }>;
  recentLogs: Array<{
    timestamp: string;
    level: string;
    message: string;
  }>;
}

interface DiagnosticEndpointNode {
  id: string;
  endpoint: number;
  deviceType: string;
  deviceTypeName: string;
  parts: DiagnosticEndpointNode[];
}

function endpointTreeNode(ep: Endpoint): DiagnosticEndpointNode {
  return {
    id: ep.id,
    endpoint: ep.number,
    deviceType: `0x${ep.type.deviceType.toString(16).padStart(4, "0")}`,
    deviceTypeName: ep.type.name,
    parts: [...ep.parts].map((p) => endpointTreeNode(p)),
  };
}

function detectEnvironment(): string {
  if (process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN) {
    return "Home Assistant Add-on";
  }
  if (process.env.DOCKER_ENV === "true" || process.env.container === "docker") {
    return "Docker";
  }
  return "Standalone";
}

function anonymizeEntityId(entityId: string): string {
  const [domain, ...rest] = entityId.split(".");
  const name = rest.join(".");
  if (!name) return entityId;
  // Keep domain and first 4 chars, hash the rest
  const prefix = name.substring(0, 4);
  const hash = simpleHash(name).toString(16).substring(0, 6);
  return `${domain}.${prefix}***${hash}`;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function anonymizeLogMessage(message: string): string {
  // Redact IP addresses
  let result = message.replace(
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    "[IP]",
  );
  // Redact IPv6 addresses
  result = result.replace(/\b[0-9a-fA-F:]{6,}\b/g, (match) => {
    if (match.includes(":") && match.length > 8) return "[IPv6]";
    return match;
  });
  // Redact MAC addresses
  result = result.replace(/\b([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b/g, "[MAC]");
  return result;
}

export function diagnosticApi(
  bridgeService: BridgeService,
  haClient: HomeAssistantClient,
  haRegistry: HomeAssistantRegistry,
  version: string,
  startTime: number,
): express.Router {
  const router = express.Router();

  router.get("/export", (req, res) => {
    const anonymize = req.query.anonymize !== "false";
    const logLimit = Math.min(
      500,
      Math.max(1, parseInt(req.query.logLimit as string, 10) || 200),
    );

    const memUsage = process.memoryUsage();
    const bridges = bridgeService.bridges;
    const haConnected = haClient.connection?.connected ?? false;

    const bridgeDetails = bridges.map((b) => {
      const data = b.data;
      const fabrics = data.commissioning?.fabrics ?? [];
      const failedEntities = data.failedEntities ?? [];

      return {
        id: data.id,
        name: anonymize ? `Bridge_${data.id.substring(0, 8)}` : data.name,
        status: data.status,
        statusReason: data.statusReason,
        port: data.port,
        deviceCount: data.deviceCount,
        serverMode: data.featureFlags?.serverMode ?? false,
        featureFlags: (data.featureFlags ?? {}) as Record<string, unknown>,
        commissioning: {
          commissioned: data.commissioning?.isCommissioned ?? false,
          fabricCount: fabrics.length,
          fabrics: fabrics.map((f) => ({
            fabricIndex: f.fabricIndex,
            label: f.label,
            rootVendorId: f.rootVendorId,
          })),
        },
        failedEntities: failedEntities.map((fe) => ({
          entityId: anonymize ? anonymizeEntityId(fe.entityId) : fe.entityId,
          reason: fe.reason,
        })),
        endpointTree: (() => {
          try {
            return endpointTreeNode(b.server);
          } catch {
            return undefined;
          }
        })(),
      };
    });

    // Get recent logs (anonymized)
    const recentLogs = logBuffer.entries
      .slice(-logLimit)
      .map((entry: LogEntry) => ({
        timestamp: entry.timestamp,
        level: entry.level,
        message: anonymize ? anonymizeLogMessage(entry.message) : entry.message,
      }));

    const report: DiagnosticReport = {
      generatedAt: new Date().toISOString(),
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      system: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        environment: detectEnvironment(),
        memory: {
          totalMB: Math.round(os.totalmem() / 1024 / 1024),
          freeMB: Math.round(os.freemem() / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
        },
      },
      homeAssistant: {
        connected: haConnected,
        entityCount: Object.keys(haRegistry.entities).length,
        deviceCount: Object.keys(haRegistry.devices).length,
      },
      bridges: bridgeDetails,
      recentLogs,
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hamh-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json"`,
    );
    res.json(report);
  });

  return router;
}
