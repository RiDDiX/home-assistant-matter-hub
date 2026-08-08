import type {
  DiagnosticBridgeInfo,
  DiagnosticEntityInfo,
  DiagnosticSnapshot,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { BridgeService } from "../bridges/bridge-service.js";
import { diagnosticEventBus } from "./diagnostic-event-bus.js";

const logger = Logger.get("DiagnosticService");

const ignoredStateKeys = new Set([
  "homeAssistantEntity",
  "bridgedDeviceBasicInformation",
  "identify",
]);

interface HaEntityState {
  entity?: {
    entity_id?: string;
    state?: { state?: string };
  };
  mapping?: Record<string, unknown>;
}

export class DiagnosticService {
  private readonly startTime: number;

  constructor(private readonly bridgeService: BridgeService) {
    this.startTime = Date.now();
  }

  private collectEntities(aggregator: {
    parts: Iterable<{ state: object }>;
  }): DiagnosticEntityInfo[] {
    const entities: DiagnosticEntityInfo[] = [];
    try {
      for (const part of aggregator.parts) {
        const state = part.state as Record<string, unknown>;
        const ha = state.homeAssistantEntity as HaEntityState | undefined;
        if (!ha?.entity?.entity_id) continue;

        const entityId = ha.entity.entity_id;
        const haState = ha.entity.state?.state ?? null;
        const available = haState !== "unavailable" && haState !== "unknown";

        const matterClusters = Object.keys(state).filter(
          (k) => !ignoredStateKeys.has(k),
        );

        const autoMappings: string[] = [];
        const mapping = ha.mapping;
        if (mapping) {
          if (typeof mapping.batteryEntity === "string")
            autoMappings.push(`Battery: ${mapping.batteryEntity}`);
          if (typeof mapping.humidityEntity === "string")
            autoMappings.push(`Humidity: ${mapping.humidityEntity}`);
          if (typeof mapping.pressureEntity === "string")
            autoMappings.push(`Pressure: ${mapping.pressureEntity}`);
          if (typeof mapping.powerEntity === "string")
            autoMappings.push(`Power: ${mapping.powerEntity}`);
          if (typeof mapping.energyEntity === "string")
            autoMappings.push(`Energy: ${mapping.energyEntity}`);
        }

        entities.push({
          entityId,
          domain: entityId.split(".")[0],
          haState,
          available,
          matterClusters,
          autoMappings,
          lastUpdate: Date.now(),
        });
      }
    } catch (e) {
      logger.warn("Failed to collect entity diagnostics:", e);
    }
    return entities;
  }

  getSnapshot(): DiagnosticSnapshot {
    const bridges: DiagnosticBridgeInfo[] = this.bridgeService.bridges.map(
      (bridge) => {
        const data = bridge.data;
        const featureFlags: Record<string, boolean> = {};
        if (data.featureFlags) {
          for (const [key, value] of Object.entries(data.featureFlags)) {
            if (typeof value === "boolean") {
              featureFlags[key] = value;
            }
          }
        }

        const entities = bridge.aggregator
          ? this.collectEntities(bridge.aggregator)
          : [];

        return {
          bridgeId: data.id,
          bridgeName: data.name,
          status: data.status,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          entityCount: data.deviceCount,
          sessionCount: data.commissioning?.fabrics?.length ?? 0,
          subscriptionCount: 0,
          featureFlags,
          entities,
        };
      },
    );

    const memUsage = process.memoryUsage();

    return {
      timestamp: Date.now(),
      bridges,
      recentEvents: diagnosticEventBus.getRecentEvents(100),
      system: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memoryMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        eventCount: diagnosticEventBus.totalEventCount,
      },
    };
  }
}
