import fs from "node:fs";
import path from "node:path";
import type {
  BridgeData,
  EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import archiver from "archiver";
import type { Request } from "express";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import type { BridgeService } from "../services/bridges/bridge-service.js";
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
  includesIdentity?: boolean;
}

export function backupApi(
  bridgeStorage: BridgeStorage,
  mappingStorage: EntityMappingStorage,
  storageLocation: string,
  _bridgeService?: BridgeService,
): express.Router {
  const router = express.Router();

  router.get("/download", async (req, res) => {
    try {
      const includeIdentity = req.query.includeIdentity === "true";
      const bridges = bridgeStorage.bridges as BridgeData[];
      const entityMappings: Record<string, unknown[]> = {};

      for (const bridge of bridges) {
        const mappings = mappingStorage.getMappingsForBridge(bridge.id);
        if (mappings.length > 0) {
          entityMappings[bridge.id] = mappings;
        }
      }

      const backupData: BackupData = {
        version: 2,
        createdAt: new Date().toISOString(),
        bridges,
        entityMappings,
        includesIdentity: includeIdentity,
      };

      const archive = archiver("zip", { zlib: { level: 9 } });
      const dateStr = new Date().toISOString().split("T")[0];
      const filename = includeIdentity
        ? `hamh-full-backup-${dateStr}.zip`
        : `hamh-backup-${dateStr}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      archive.pipe(res);
      archive.append(JSON.stringify(backupData, null, 2), {
        name: "backup.json",
      });
      archive.append(
        `Home Assistant Matter Hub Backup\nCreated: ${backupData.createdAt}\nBridges: ${bridges.length}\nIncludes Identity: ${includeIdentity}\n\nWARNING: ${includeIdentity ? "This backup contains sensitive Matter identity data (keypairs, fabric credentials). Keep it secure!" : "This backup does NOT include Matter identity data. Bridges will need to be re-commissioned after restore."}\n`,
        { name: "README.txt" },
      );

      if (includeIdentity) {
        for (const bridge of bridges) {
          const bridgeStoragePath = path.join(storageLocation, bridge.id);
          if (fs.existsSync(bridgeStoragePath)) {
            archive.directory(bridgeStoragePath, `identity/${bridge.id}`);
          }
        }
      }

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

        const { backupData } = await extractBackupData(req.file.buffer);
        const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

        const preview = {
          version: backupData.version,
          createdAt: backupData.createdAt,
          includesIdentity: backupData.includesIdentity ?? false,
          bridges: backupData.bridges.map((bridge: BridgeData) => ({
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
          restoreIdentity?: boolean;
        };

        const { backupData, zipDirectory } = await extractBackupData(
          req.file.buffer,
        );
        const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

        const bridgesToRestore = options.bridgeIds
          ? backupData.bridges.filter((b) => options.bridgeIds!.includes(b.id))
          : backupData.bridges;

        let bridgesRestored = 0;
        let bridgesSkipped = 0;
        let mappingsRestored = 0;
        let identitiesRestored = 0;
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

            if (
              options.restoreIdentity !== false &&
              backupData.includesIdentity
            ) {
              const identityRestored = await restoreIdentityFiles(
                zipDirectory,
                bridge.id,
                storageLocation,
              );
              if (identityRestored) {
                identitiesRestored++;
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
          identitiesRestored,
          errors,
          restartRequired: bridgesRestored > 0 || identitiesRestored > 0,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to restore backup";
        res.status(400).json({ error: message });
      }
    },
  );

  router.post("/restart", async (_, res) => {
    res.json({ message: "Restarting application..." });
    // Give time for response to be sent before exiting
    setTimeout(() => {
      process.exit(0);
    }, 500);
  });

  return router;
}

interface ExtractedBackup {
  backupData: BackupData;
  zipDirectory: unzipper.CentralDirectory;
}

async function extractBackupData(buffer: Buffer): Promise<ExtractedBackup> {
  const directory = await unzipper.Open.buffer(buffer);
  const backupFile = directory.files.find(
    (f: { path: string }) => f.path === "backup.json",
  );
  if (!backupFile) {
    throw new Error("Invalid backup: backup.json not found");
  }
  const content = await backupFile.buffer();
  const data = JSON.parse(content.toString()) as BackupData;
  return { backupData: data, zipDirectory: directory };
}

async function restoreIdentityFiles(
  zipDirectory: unzipper.CentralDirectory,
  bridgeId: string,
  storageLocation: string,
): Promise<boolean> {
  const identityPrefix = `identity/${bridgeId}/`;
  const identityFiles = zipDirectory.files.filter(
    (f: { path: string; type: string }) =>
      f.path.startsWith(identityPrefix) && f.type === "File",
  );

  if (identityFiles.length === 0) {
    return false;
  }

  const targetDir = path.join(storageLocation, bridgeId);
  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of identityFiles) {
    const relativePath = file.path.substring(identityPrefix.length);
    const targetPath = path.join(targetDir, relativePath);
    const targetDirPath = path.dirname(targetPath);

    fs.mkdirSync(targetDirPath, { recursive: true });

    const content = await file.buffer();
    fs.writeFileSync(targetPath, content);
  }

  return true;
}
