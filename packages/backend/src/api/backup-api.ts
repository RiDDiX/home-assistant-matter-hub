import fs from "node:fs";
import path from "node:path";
import {
  type BridgeData,
  BridgeStatus,
  type EntityMappingConfig,
} from "@home-assistant-matter-hub/common";
import { StorageBackendMemory, StorageContext } from "@matter/general";
import archiver from "archiver";
import type { Request } from "express";
import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import { pluginStateFilePath } from "../plugins/plugin-storage.js";
import {
  APP_BACKUP_FILES,
  archiveSecretFiles,
  type BackupService,
} from "../services/backup/backup-service.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type {
  AppSettingsStorage,
  BackupSettings,
} from "../services/storage/app-settings-storage.js";
import {
  BRIDGE_SCHEMA_VERSION,
  type BridgeStorage,
  bridgeMigrations,
} from "../services/storage/bridge-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});
const MAX_BACKUP_JSON_BYTES = 50 * 1024 * 1024;
// Bridge ids become directory names below the storage location on restore.
// Imported legacy bridges keep dashed UUIDs or their old id.
const BRIDGE_ID = /^[\w-]+$/;
// Bridge schema in use when backups were introduced, for backups that predate
// bridgeVersion.
const FIRST_BACKUP_BRIDGE_VERSION = 5;

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

interface RestoreOptions {
  bridgeIds?: string[];
  overwriteExisting?: boolean;
  includeMappings?: boolean;
  restoreIdentity?: boolean;
}

export interface BackupData {
  version: number;
  bridgeVersion?: number;
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
  bridgeService: BridgeService,
): express.Router {
  const router = express.Router();

  async function restore(
    buffer: Buffer,
    options: RestoreOptions,
    res: express.Response,
  ) {
    const { backupData, zipDirectory } = await extractBackupData(buffer);
    const existingIds = new Set(bridgeStorage.bridges.map((b) => b.id));

    const bridgeIds = options.bridgeIds;
    const bridgesToRestore = bridgeIds
      ? backupData.bridges.filter((b) => bridgeIds.includes(b.id))
      : backupData.bridges;
    const restoreIdentity =
      options.restoreIdentity !== false && !!backupData.includesIdentity;
    const bridgeVersion =
      backupData.bridgeVersion ?? FIRST_BACKUP_BRIDGE_VERSION;

    let bridgesRestored = 0;
    let bridgesSkipped = 0;
    let mappingsRestored = 0;
    let identitiesRestored = 0;
    let iconsRestored = 0;
    const errors: Array<{ bridgeId: string; error: string }> = [];

    for (const bridge of bridgesToRestore) {
      try {
        if (!BRIDGE_ID.test(bridge.id)) {
          throw new Error(`Invalid bridge id: ${bridge.id}`);
        }
        const exists = existingIds.has(bridge.id);
        if (exists && !options.overwriteExisting) {
          bridgesSkipped++;
          continue;
        }

        // A running bridge keeps writing its old fabrics and sessions over
        // the restored files until the restart.
        const live = bridgeService.get(bridge.id);
        if (live && live.data.status !== BridgeStatus.Stopped) {
          await live.stop();
        }

        await bridgeStorage.add(await migrateBridge(bridge, bridgeVersion));
        bridgesRestored++;

        if (options.includeMappings !== false) {
          const mappings = backupData.entityMappings[bridge.id];
          if (mappings) {
            for (const mapping of mappings) {
              const config = mapping as EntityMappingConfig;
              if (typeof config?.entityId !== "string") continue;
              // setMapping sanitizes field by field, no list here to drift
              await mappingStorage.setMapping({
                ...config,
                bridgeId: bridge.id,
              });
              mappingsRestored++;
            }
          }
        }

        if (restoreIdentity) {
          const identityRestored = await restoreIdentityFiles(
            zipDirectory,
            bridge.id,
            storageLocation,
          );
          if (identityRestored) {
            identitiesRestored++;
          }
          await restorePluginConfigs(zipDirectory, bridge.id, storageLocation);
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

        await restorePluginState(zipDirectory, bridge.id, storageLocation);
      } catch (e) {
        errors.push({
          bridgeId: bridge.id,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    let appRestored = false;
    if (restoreIdentity) {
      try {
        appRestored = await restoreAppFiles(
          zipDirectory,
          storageLocation,
          bridgeService,
        );
      } catch (e) {
        errors.push({
          bridgeId: "app",
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    res.status(bridgesRestored === 0 && errors.length > 0 ? 207 : 200).json({
      bridgesRestored,
      bridgesSkipped,
      mappingsRestored,
      identitiesRestored,
      iconsRestored,
      errors,
      restartRequired:
        bridgesRestored > 0 || identitiesRestored > 0 || appRestored,
    });
  }

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
        bridgeVersion: BRIDGE_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        bridges,
        entityMappings,
        includesIdentity: includeIdentity,
        includesIcons,
      };

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", () => res.destroy());
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

      // The manager's per-bridge plugin state (enabled flags) lives at the
      // storage root, outside the identity directory, so it travels
      // explicitly (#439).
      for (const bridge of bridges) {
        const pluginState = pluginStateFilePath(storageLocation, bridge.id);
        if (fs.existsSync(pluginState)) {
          archive.file(pluginState, { name: `plugin-state/${bridge.id}.json` });
        }
      }

      if (includeIdentity) {
        for (const bridge of bridges) {
          const bridgeStoragePath = path.join(storageLocation, bridge.id);
          if (fs.existsSync(bridgeStoragePath)) {
            archive.directory(bridgeStoragePath, `identity/${bridge.id}`);
          }
        }
        archiveSecretFiles(
          archive,
          storageLocation,
          bridges.map((b) => b.id),
        );

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

        const options = JSON.parse(req.body.options || "{}") as RestoreOptions;
        await restore(req.file.buffer, options, res);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to restore backup";
        res.status(400).json({ error: message });
      }
    },
  );

  router.post("/restart", async (_, res) => {
    res.json({ message: "Restarting application..." });
    // Signal the graceful shutdown path instead of exiting directly.
    // The SIGTERM handler disposes bridges, HA client, and storage in
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
      // An unhandled stream error (a file deleted meanwhile) exits the process
      stream.on("error", () => res.destroy());
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

      await restore(
        fs.readFileSync(filepath),
        (req.body || {}) as RestoreOptions,
        res,
      );
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
      const { autoBackup, backupRetentionCount } = (req.body ?? {}) as {
        autoBackup?: unknown;
        backupRetentionCount?: unknown;
      };
      const next: Partial<BackupSettings> = {};
      if (autoBackup !== undefined) {
        if (typeof autoBackup !== "boolean") {
          res.status(400).json({ error: "autoBackup must be a boolean" });
          return;
        }
        next.autoBackup = autoBackup;
      }
      if (backupRetentionCount !== undefined) {
        // Same bounds as the settings form; anything else used to be stored
        // as-is and could make retention delete every backup.
        if (
          typeof backupRetentionCount !== "number" ||
          !Number.isInteger(backupRetentionCount) ||
          backupRetentionCount < 1 ||
          backupRetentionCount > 100
        ) {
          res.status(400).json({
            error: "backupRetentionCount must be an integer between 1 and 100",
          });
          return;
        }
        next.backupRetentionCount = backupRetentionCount;
      }
      await settingsStorage.setBackupSettings(next);
      res.json(settingsStorage.backupSettings);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update settings";
      res.status(500).json({ error: message });
    }
  });

  // multer reports an oversized upload through next(err)
  router.use(
    (
      err: unknown,
      _req: Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err instanceof multer.MulterError ? 413 : 400).json({
        error: err instanceof Error ? err.message : "Upload failed",
      });
    },
  );

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
  if (backupFile.uncompressedSize > MAX_BACKUP_JSON_BYTES) {
    throw new Error("Invalid backup: backup.json is larger than 50 MB");
  }
  const content = await backupFile.buffer();
  const data = JSON.parse(content.toString()) as BackupData;
  return { backupData: data, zipDirectory: directory };
}

// The store migrations run on a whole store, so the record goes through a
// throwaway one.
async function migrateBridge(
  bridge: BridgeData,
  version: number,
): Promise<BridgeData> {
  const backend = new StorageBackendMemory();
  backend.initialize();
  const storage = new StorageContext(backend, ["bridges"]);
  await storage.set("ids", [bridge.id]);
  await storage.set(bridge.id, bridge as unknown as Record<string, string>);
  while (bridgeMigrations[version]) {
    version = await bridgeMigrations[version](storage);
  }
  return (await storage.get(bridge.id)) as unknown as BridgeData;
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

// Plugin configs of a bridge, plugin-<bridgeId>-<plugin>.json at the storage
// root. They hold credentials, so only full backups carry them.
async function restorePluginConfigs(
  zipDirectory: unzipper.CentralDirectory,
  bridgeId: string,
  storageLocation: string,
): Promise<void> {
  for (const file of zipDirectory.files) {
    const name = file.path.slice("plugins/".length);
    if (
      file.type !== "File" ||
      !file.path.startsWith(`plugins/plugin-${bridgeId}-`) ||
      !name.endsWith(".json")
    ) {
      continue;
    }
    const targetPath = name.includes("/")
      ? null
      : resolveWithin(storageLocation, name);
    if (!targetPath) {
      throw new Error(
        `Refusing to restore plugin file with unsafe path: ${file.path}`,
      );
    }
    fs.writeFileSync(targetPath, await file.buffer());
  }
}

// Lock PINs, login and entity identities live in the app namespace that the
// running storages rewrite from memory, so every bridge stops first and the
// restart follows.
async function restoreAppFiles(
  zipDirectory: unzipper.CentralDirectory,
  storageLocation: string,
  bridgeService: BridgeService,
): Promise<boolean> {
  const entries = zipDirectory.files.filter(
    (f: { path: string; type: string }) =>
      f.type === "File" && APP_BACKUP_FILES.some((n) => f.path === `app/${n}`),
  );
  if (entries.length === 0) {
    return false;
  }
  const active = () =>
    bridgeService.bridges.filter(
      (b) =>
        b.data.status === BridgeStatus.Running ||
        b.data.status === BridgeStatus.Starting,
    );
  await Promise.allSettled(active().map((b) => b.stop()));
  if (active().length > 0) {
    throw new Error(
      "Lock PINs, login and entity identities were not restored because a bridge did not stop. Stop all bridges and restore again.",
    );
  }
  const appDir = path.join(storageLocation, "app");
  fs.mkdirSync(appDir, { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(
      path.join(appDir, entry.path.slice("app/".length)),
      await entry.buffer(),
    );
  }
  return true;
}

// The disabled-plugins choice of a bridge, written back to the manager's
// per-bridge state file (#439). The target path is sanitized by
// pluginStateFilePath, the zip entry is matched exactly.
async function restorePluginState(
  zipDirectory: unzipper.CentralDirectory,
  bridgeId: string,
  storageLocation: string,
): Promise<boolean> {
  const entry = zipDirectory.files.find(
    (f: { path: string; type: string }) =>
      f.path === `plugin-state/${bridgeId}.json` && f.type === "File",
  );
  if (!entry) {
    return false;
  }
  const content = await entry.buffer();
  fs.writeFileSync(pluginStateFilePath(storageLocation, bridgeId), content);
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
