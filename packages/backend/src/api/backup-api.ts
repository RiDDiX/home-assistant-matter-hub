import type {
  BridgeData,
  EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import archiver from "archiver";
import type { Request } from "express";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";

const upload = multer({ storage: multer.memoryStorage() });

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

export interface BackupData {
  version: number;
  createdAt: string;
  bridges: BridgeData[];
  entityMappings: Record<string, unknown[]>;
}

export function backupApi(
  bridgeStorage: BridgeStorage,
  mappingStorage: EntityMappingStorage,
): express.Router {
  const router = express.Router();

  router.get("/download", async (_, res) => {
    try {
      const bridges = bridgeStorage.bridges as BridgeData[];
      const entityMappings: Record<string, unknown[]> = {};

      for (const bridge of bridges) {
        const mappings = mappingStorage.getMappingsForBridge(bridge.id);
        if (mappings.length > 0) {
          entityMappings[bridge.id] = mappings;
        }
      }

      const backupData: BackupData = {
        version: 1,
        createdAt: new Date().toISOString(),
        bridges,
        entityMappings,
      };

      const archive = archiver("zip", { zlib: { level: 9 } });
      const dateStr = new Date().toISOString().split("T")[0];

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="hamh-backup-${dateStr}.zip"`,
      );

      archive.pipe(res);
      archive.append(JSON.stringify(backupData, null, 2), {
        name: "backup.json",
      });
      archive.append(
        `Home Assistant Matter Hub Backup\nCreated: ${backupData.createdAt}\nBridges: ${bridges.length}\n`,
        { name: "README.txt" },
      );

      await archive.finalize();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create backup";
      res.status(500).json({ error: message });
    }
  });

  router.post(
    "/restore/preview",
    upload.single("file"),
    async (req: MulterRequest, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "No file uploaded" });
          return;
        }

        const backupData = await extractBackupData(req.file.buffer);
        const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

        const preview = {
          version: backupData.version,
          createdAt: backupData.createdAt,
          bridges: backupData.bridges.map((bridge) => ({
            id: bridge.id,
            name: bridge.name,
            port: bridge.port,
            exists: existingIds.has(bridge.id),
            hasMappings: !!backupData.entityMappings[bridge.id],
            mappingCount: backupData.entityMappings[bridge.id]?.length || 0,
          })),
        };

        res.json(preview);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to parse backup file";
        res.status(400).json({ error: message });
      }
    },
  );

  router.post(
    "/restore",
    upload.single("file"),
    async (req: MulterRequest, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "No file uploaded" });
          return;
        }

        const options = JSON.parse(req.body.options || "{}") as {
          bridgeIds?: string[];
          overwriteExisting?: boolean;
          includeMappings?: boolean;
        };

        const backupData = await extractBackupData(req.file.buffer);
        const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

        const bridgesToRestore = options.bridgeIds
          ? backupData.bridges.filter((b) => options.bridgeIds!.includes(b.id))
          : backupData.bridges;

        let bridgesRestored = 0;
        let bridgesSkipped = 0;
        let mappingsRestored = 0;
        const errors: Array<{ bridgeId: string; error: string }> = [];

        for (const bridge of bridgesToRestore) {
          try {
            const exists = existingIds.has(bridge.id);
            if (exists && !options.overwriteExisting) {
              bridgesSkipped++;
              continue;
            }

            await bridgeStorage.add(bridge);
            bridgesRestored++;

            if (options.includeMappings !== false) {
              const mappings = backupData.entityMappings[bridge.id];
              if (mappings) {
                for (const mapping of mappings) {
                  const config = mapping as EntityMappingConfig;
                  await mappingStorage.setMapping({
                    bridgeId: bridge.id,
                    entityId: config.entityId,
                    matterDeviceType: config.matterDeviceType,
                    customName: config.customName,
                    disabled: config.disabled,
                  });
                  mappingsRestored++;
                }
              }
            }
          } catch (e) {
            errors.push({
              bridgeId: bridge.id,
              error: e instanceof Error ? e.message : "Unknown error",
            });
          }
        }

        res.json({
          bridgesRestored,
          bridgesSkipped,
          mappingsRestored,
          errors,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to restore backup";
        res.status(400).json({ error: message });
      }
    },
  );

  return router;
}

async function extractBackupData(buffer: Buffer): Promise<BackupData> {
  const directory = await unzipper.Open.buffer(buffer);
  const backupFile = directory.files.find(
    (f: { path: string }) => f.path === "backup.json",
  );
  if (!backupFile) {
    throw new Error("Invalid backup: backup.json not found");
  }
  const content = await backupFile.buffer();
  const data = JSON.parse(content.toString()) as BackupData;
  return data;
}
