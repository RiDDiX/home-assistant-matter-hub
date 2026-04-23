import fs from "node:fs";
import path from "node:path";
import type {
  BridgeData,
  EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import * as archiver from "archiver";
import type { Request } from "express";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import type { BackupService } from "../services/backup/backup-service.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { AppSettingsStorage } from "../services/storage/app-settings-storage.js";
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
  includesIcons?: boolean;
}

export function backupApi(
  bridgeStorage: BridgeStorage,
  mappingStorage: EntityMappingStorage,
  storageLocation: string,
  backupService: BackupService,
  settingsStorage: AppSettingsStorage,
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

      // Check if bridge icons exist before creating backupData
      let includesIcons = false;
      const iconsDir = path.join(storageLocation, "bridge-icons");
      if (includeIdentity && fs.existsSync(iconsDir)) {
        const iconFiles = fs.readdirSync(iconsDir);
        includesIcons = iconFiles.some((iconFile) => {
          const bridgeId = iconFile.split(".")[0];
          return bridges.some((b) => b.id === bridgeId);
        });
      }

      const backupData: BackupData = {
        version: 2,
        createdAt: new Date().toISOString(),
        bridges,
        entityMappings,
        includesIdentity: includeIdentity,
        includesIcons,
      };

      const archive = archiver.create("zip", { zlib: { level: 9 } });
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
        `Home Assistant Matter Hub Backup\nCreated: ${backupData.createdAt}\nBridges: ${bridges.length}\nIncludes Identity: ${includeIdentity}\nIncludes Icons: ${includesIcons}\n\nWARNING: ${includeIdentity ? "This backup contains sensitive Matter identity data (keypairs, fabric credentials). Keep it secure!" : "This backup does NOT include Matter identity data. Bridges will need to be re-commissioned after restore."}\n`,
        { name: "README.txt" },
      );

      if (includeIdentity) {
        for (const bridge of bridges) {
          const bridgeStoragePath = path.join(storageLocation, bridge.id);
          if (fs.existsSync(bridgeStoragePath)) {
            archive.directory(bridgeStoragePath, `identity/${bridge.id}`);
          }
        }

        // Include bridge icons
        if (includesIcons) {
          const iconFiles = fs.readdirSync(iconsDir);
          for (const iconFile of iconFiles) {
            const bridgeId = iconFile.split(".")[0];
            if (bridges.some((b) => b.id === bridgeId)) {
              const iconPath = path.join(iconsDir, iconFile);
              archive.file(iconPath, { name: `bridge-icons/${iconFile}` });
            }
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
        let iconsRestored = 0;
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
                    filterLifeEntity: config.filterLifeEntity,
                    cleaningModeEntity: config.cleaningModeEntity,
                    temperatureEntity: config.temperatureEntity,
                    humidityEntity: config.humidityEntity,
                    pressureEntity: config.pressureEntity,
                    batteryEntity: config.batteryEntity,
                    roomEntities: config.roomEntities,
                    disableLockPin: config.disableLockPin,
                    powerEntity: config.powerEntity,
                    energyEntity: config.energyEntity,
                    suctionLevelEntity: config.suctionLevelEntity,
                    mopIntensityEntity: config.mopIntensityEntity,
                    valetudoIdentifier: config.valetudoIdentifier,
                    coverSwapOpenClose: config.coverSwapOpenClose,
                    customServiceAreas: config.customServiceAreas,
                    customFanSpeedTags: config.customFanSpeedTags,
                    composedEntities: config.composedEntities,
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

            // Restore bridge icons
            if (backupData.includesIcons) {
              const iconRestored = await restoreBridgeIcon(
                zipDirectory,
                bridge.id,
                storageLocation,
              );
              if (iconRestored) {
                iconsRestored++;
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
          iconsRestored,
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
    // Signal the graceful shutdown path instead of exiting directly —
    // the SIGTERM handler disposes bridges, HA client, and storage in
    // reverse order before the process exits.
    setTimeout(() => {
      process.kill(process.pid, "SIGTERM");
    }, 500);
  });

  // --- Snapshot management endpoints ---

  router.get("/snapshots", async (_, res) => {
    try {
      const backups = backupService.listBackups();
      res.json(backups);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to list backups";
      res.status(500).json({ error: message });
    }
  });

  router.post("/snapshots/create", async (_, res) => {
    try {
      const metadata = await backupService.createBackup(false);
      res.json(metadata);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create backup";
      res.status(500).json({ error: message });
    }
  });

  router.get("/snapshots/:filename/download", async (req, res) => {
    try {
      const filepath = backupService.getBackupPath(req.params.filename);
      if (!filepath) {
        res.status(404).json({ error: "Backup not found" });
        return;
      }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${req.params.filename}"`,
      );
      const stream = fs.createReadStream(filepath);
      stream.pipe(res);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to download backup";
      res.status(500).json({ error: message });
    }
  });

  router.post("/snapshots/:filename/restore", async (req, res) => {
    try {
      const filepath = backupService.getBackupPath(req.params.filename);
      if (!filepath) {
        res.status(404).json({ error: "Backup not found" });
        return;
      }

      const buffer = fs.readFileSync(filepath);
      const options = (req.body || {}) as {
        bridgeIds?: string[];
        overwriteExisting?: boolean;
        includeMappings?: boolean;
        restoreIdentity?: boolean;
      };

      const { backupData, zipDirectory } = await extractBackupData(buffer);
      const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

      const bridgesToRestore = options.bridgeIds
        ? backupData.bridges.filter((b) => options.bridgeIds!.includes(b.id))
        : backupData.bridges;

      let bridgesRestored = 0;
      let bridgesSkipped = 0;
      let mappingsRestored = 0;
      let identitiesRestored = 0;
      let iconsRestored = 0;
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
                  filterLifeEntity: config.filterLifeEntity,
                  cleaningModeEntity: config.cleaningModeEntity,
                  humidityEntity: config.humidityEntity,
                  pressureEntity: config.pressureEntity,
                  batteryEntity: config.batteryEntity,
                  roomEntities: config.roomEntities,
                  disableLockPin: config.disableLockPin,
                  powerEntity: config.powerEntity,
                  energyEntity: config.energyEntity,
                  suctionLevelEntity: config.suctionLevelEntity,
                  mopIntensityEntity: config.mopIntensityEntity,
                  temperatureEntity: config.temperatureEntity,
                  valetudoIdentifier: config.valetudoIdentifier,
                  coverSwapOpenClose: config.coverSwapOpenClose,
                  customServiceAreas: config.customServiceAreas,
                  customFanSpeedTags: config.customFanSpeedTags,
                  composedEntities: config.composedEntities,
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

          if (backupData.includesIcons) {
            const iconRestored = await restoreBridgeIcon(
              zipDirectory,
              bridge.id,
              storageLocation,
            );
            if (iconRestored) {
              iconsRestored++;
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
        iconsRestored,
        errors,
        restartRequired: bridgesRestored > 0 || identitiesRestored > 0,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to restore from snapshot";
      res.status(400).json({ error: message });
    }
  });

  router.delete("/snapshots/:filename", async (req, res) => {
    try {
      const deleted = backupService.deleteBackup(req.params.filename);
      if (!deleted) {
        res.status(404).json({ error: "Backup not found" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to delete backup";
      res.status(500).json({ error: message });
    }
  });

  // --- Backup settings endpoints ---

  router.get("/settings", async (_, res) => {
    try {
      res.json(settingsStorage.backupSettings);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to get settings";
      res.status(500).json({ error: message });
    }
  });

  router.put("/settings", async (req, res) => {
    try {
      const body = req.body as {
        autoBackup?: boolean;
        backupRetentionCount?: number;
      };
      await settingsStorage.setBackupSettings(body);
      res.json(settingsStorage.backupSettings);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update settings";
      res.status(500).json({ error: message });
    }
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

function resolveWithin(baseDir: string, relative: string): string | null {
  if (relative.length === 0 || path.isAbsolute(relative)) {
    return null;
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relative);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    return null;
  }
  return resolvedTarget;
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
    const targetPath = resolveWithin(targetDir, relativePath);
    if (!targetPath) {
      throw new Error(
        `Refusing to restore identity file with unsafe path: ${file.path}`,
      );
    }
    const targetDirPath = path.dirname(targetPath);

    fs.mkdirSync(targetDirPath, { recursive: true });

    const content = await file.buffer();
    fs.writeFileSync(targetPath, content);
  }

  return true;
}

async function restoreBridgeIcon(
  zipDirectory: unzipper.CentralDirectory,
  bridgeId: string,
  storageLocation: string,
): Promise<boolean> {
  const iconPrefix = "bridge-icons/";
  const iconFiles = zipDirectory.files.filter(
    (f: { path: string; type: string }) =>
      f.path.startsWith(iconPrefix) &&
      f.path.split("/")[1]?.startsWith(`${bridgeId}.`) &&
      f.type === "File",
  );

  if (iconFiles.length === 0) {
    return false;
  }

  const iconsDir = path.join(storageLocation, "bridge-icons");
  fs.mkdirSync(iconsDir, { recursive: true });

  for (const file of iconFiles) {
    const fileName = file.path.substring(iconPrefix.length);
    const targetPath = resolveWithin(iconsDir, fileName);
    if (!targetPath) {
      throw new Error(
        `Refusing to restore bridge icon with unsafe path: ${file.path}`,
      );
    }

    const content = await file.buffer();
    fs.writeFileSync(targetPath, content);
  }

  return true;
}
