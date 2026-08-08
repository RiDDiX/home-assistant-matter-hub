import type {
  BridgeData,
  BridgeExportData,
  BridgeImportError,
  BridgeImportPreview,
  BridgeImportRequest,
  BridgeImportResult,
  HomeAssistantFilter,
  HomeAssistantMatcher,
} from "@home-assistant-matter-hub/common";
import { HomeAssistantMatcherType } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import express from "express";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";

const logger = Logger.get("BridgeExportApi");

type LegacyMatcher = string | HomeAssistantMatcher;

interface LegacyFilter {
  include?: LegacyMatcher[];
  exclude?: LegacyMatcher[];
}

interface LegacyBridgeData {
  id?: string;
  name: string;
  port: number;
  filter?: LegacyFilter;
  featureFlags?: Record<string, boolean>;
  basicInformation?: Record<string, unknown>;
  countryCode?: string;
  icon?: string;
  priority?: number;
}

interface LegacyExportData {
  version?: number;
  exportedAt?: string;
  bridges?: LegacyBridgeData[];
}

function migrateFilter(legacyFilter?: LegacyFilter): HomeAssistantFilter {
  if (!legacyFilter) {
    return { include: [], exclude: [] };
  }

  const migrateMatcher = (m: LegacyMatcher): HomeAssistantMatcher => {
    if (typeof m === "string") {
      return { type: HomeAssistantMatcherType.Pattern, value: m };
    }
    return m;
  };

  return {
    include: (legacyFilter.include || []).map(migrateMatcher),
    exclude: (legacyFilter.exclude || []).map(migrateMatcher),
  };
}

function migrateBridge(legacy: LegacyBridgeData): BridgeData {
  return {
    id: legacy.id || crypto.randomUUID(),
    name: legacy.name,
    port: legacy.port,
    filter: migrateFilter(legacy.filter),
    featureFlags: legacy.featureFlags,
    countryCode: legacy.countryCode,
    icon: legacy.icon,
    priority: legacy.priority,
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "Home Assistant Matter Hub",
      productId: 0x8000,
      productName: legacy.name,
      productLabel: legacy.name,
      hardwareVersion: 1,
      softwareVersion: 1,
      ...(legacy.basicInformation as Record<string, unknown>),
    },
  } as BridgeData;
}

function migrateExportData(data: LegacyExportData): {
  exportData: BridgeExportData;
  migrated: boolean;
  sourceVersion: string;
} {
  const hasVersion = typeof data.version === "number";
  const hasBridges = Array.isArray(data.bridges);

  if (!hasBridges) {
    throw new Error("Invalid export file: no bridges array found");
  }

  const needsMigration = !hasVersion || data.version === 0;
  const sourceVersion = hasVersion ? `v${data.version}` : "legacy (pre-v1)";

  const migratedBridges = data.bridges!.map((b: LegacyBridgeData) =>
    migrateBridge(b),
  );

  return {
    exportData: {
      version: 1,
      exportedAt: data.exportedAt || new Date().toISOString(),
      bridges: migratedBridges,
    },
    migrated: needsMigration,
    sourceVersion,
  };
}

export function bridgeExportApi(bridgeStorage: BridgeStorage): express.Router {
  const router = express.Router();

  router.get("/export", (_, res) => {
    const bridges = bridgeStorage.bridges;
    const exportData: BridgeExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      bridges: bridges as BridgeData[],
    };
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hamh-bridges-${new Date().toISOString().split("T")[0]}.json"`,
    );
    res.json(exportData);
  });

  router.get("/export/:bridgeId", (req, res) => {
    const { bridgeId } = req.params;
    const bridge = bridgeStorage.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).json({ error: "Bridge not found" });
      return;
    }
    const exportData: BridgeExportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      bridges: [bridge as BridgeData],
    };
    const safeName = bridge.name.replace(/[^a-zA-Z0-9]/g, "-");
    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hamh-bridge-${safeName}-${new Date().toISOString().split("T")[0]}.json"`,
    );
    res.json(exportData);
  });

  router.post("/import/preview", (req, res) => {
    try {
      const rawData = req.body as LegacyExportData;
      const { exportData, migrated, sourceVersion } =
        migrateExportData(rawData);

      const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));
      const preview: BridgeImportPreview & {
        migrated: boolean;
        sourceVersion: string;
      } = {
        version: exportData.version,
        exportedAt: exportData.exportedAt,
        migrated,
        sourceVersion,
        bridges: exportData.bridges.map((bridge: BridgeData) => ({
          id: bridge.id,
          name: bridge.name,
          port: bridge.port,
          entityCount:
            (bridge.filter.include?.length || 0) +
            (bridge.filter.exclude?.length || 0),
          exists: existingIds.has(bridge.id),
        })),
      };
      res.json(preview);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to parse export file";
      res.status(400).json({ error: message });
    }
  });

  router.post("/import", async (req, res) => {
    try {
      const { data: rawData, options } = req.body as {
        data: LegacyExportData;
        options: BridgeImportRequest;
      };

      const { exportData } = migrateExportData(rawData);

      const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));
      const bridgesToImport = exportData.bridges.filter((b: BridgeData) =>
        options.bridgeIds.includes(b.id),
      );

      let imported = 0;
      let skipped = 0;
      const errors: BridgeImportError[] = [];

      for (const bridge of bridgesToImport) {
        try {
          const exists = existingIds.has(bridge.id);
          if (exists && !options.overwriteExisting) {
            skipped++;
            continue;
          }

          await bridgeStorage.add(bridge);
          imported++;
        } catch (e) {
          errors.push({
            bridgeId: bridge.id,
            bridgeName: bridge.name,
            reason: e instanceof Error ? e.message : "Unknown error",
          });
        }
      }

      const result: BridgeImportResult = { imported, skipped, errors };
      res.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to import bridges: ${message}`, e);
      res.status(400).json({ error: `Failed to import bridges: ${message}` });
    }
  });

  return router;
}
