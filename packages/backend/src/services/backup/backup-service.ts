import fs from "node:fs";
import path from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import archiver from "archiver";
import type { AppSettingsStorage } from "../storage/app-settings-storage.js";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";

export interface BackupMetadata {
  filename: string;
  version: string;
  createdAt: string;
  sizeBytes: number;
  auto: boolean;
}

export interface BackupServiceProps {
  storageLocation: string;
  appVersion: string;
}

export class BackupService {
  private readonly log = Logger.get("BackupService");
  private readonly backupDir: string;

  constructor(
    private readonly bridgeStorage: BridgeStorage,
    private readonly mappingStorage: EntityMappingStorage,
    private readonly settingsStorage: AppSettingsStorage,
    private readonly props: BackupServiceProps,
  ) {
    this.backupDir = path.join(props.storageLocation, "backups");
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  async createBackup(auto: boolean): Promise<BackupMetadata> {
    const now = new Date();
    const version = this.props.appVersion;
    const dateStr = now
      .toISOString()
      .replace(/T/, "_")
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    const prefix = auto ? "auto" : "manual";
    const filename = `hamh-${prefix}-${version}-${dateStr}.zip`;
    const filepath = path.join(this.backupDir, filename);

    const bridges = this.bridgeStorage.bridges as BridgeData[];
    const entityMappings: Record<string, unknown[]> = {};
    for (const bridge of bridges) {
      const mappings = this.mappingStorage.getMappingsForBridge(bridge.id);
      if (mappings.length > 0) {
        entityMappings[bridge.id] = mappings;
      }
    }

    let includesIcons = false;
    const iconsDir = path.join(this.props.storageLocation, "bridge-icons");
    if (fs.existsSync(iconsDir)) {
      const iconFiles = fs.readdirSync(iconsDir);
      includesIcons = iconFiles.some((f) => {
        const bridgeId = f.split(".")[0];
        return bridges.some((b) => b.id === bridgeId);
      });
    }

    const backupData = {
      version: 2,
      createdAt: now.toISOString(),
      bridges,
      entityMappings,
      includesIdentity: true,
      includesIcons,
      appVersion: version,
      auto,
    };

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(filepath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => resolve());
      archive.on("error", (err) => reject(err));
      archive.pipe(output);

      archive.append(JSON.stringify(backupData, null, 2), {
        name: "backup.json",
      });
      archive.append(
        [
          "Home Assistant Matter Hub Backup",
          `Created: ${backupData.createdAt}`,
          `Version: ${version}`,
          `Type: ${auto ? "Automatic" : "Manual"}`,
          `Bridges: ${bridges.length}`,
          `Includes Identity: true`,
          `Includes Icons: ${includesIcons}`,
          "",
          "WARNING: This backup contains sensitive Matter identity data (keypairs, fabric credentials). Keep it secure!",
          "",
        ].join("\n"),
        { name: "README.txt" },
      );

      for (const bridge of bridges) {
        const bridgeStoragePath = path.join(
          this.props.storageLocation,
          bridge.id,
        );
        if (fs.existsSync(bridgeStoragePath)) {
          archive.directory(bridgeStoragePath, `identity/${bridge.id}`);
        }
      }

      if (includesIcons) {
        const iconFiles = fs.readdirSync(iconsDir);
        for (const iconFile of iconFiles) {
          const bridgeId = iconFile.split(".")[0];
          if (bridges.some((b) => b.id === bridgeId)) {
            archive.file(path.join(iconsDir, iconFile), {
              name: `bridge-icons/${iconFile}`,
            });
          }
        }
      }

      archive.finalize();
    });

    const stat = fs.statSync(filepath);
    const metadata: BackupMetadata = {
      filename,
      version,
      createdAt: now.toISOString(),
      sizeBytes: stat.size,
      auto,
    };

    this.log.info(
      `Backup created: ${filename} (${Math.round(stat.size / 1024)} KB)`,
    );

    await this.enforceRetention();
    return metadata;
  }

  async createAutoBackup(): Promise<BackupMetadata | null> {
    const settings = this.settingsStorage.backupSettings;
    if (!settings.autoBackup) {
      this.log.debug("Auto-backup disabled, skipping");
      return null;
    }

    try {
      return await this.createBackup(true);
    } catch (e) {
      this.log.error("Auto-backup failed:", e);
      return null;
    }
  }

  listBackups(): BackupMetadata[] {
    if (!fs.existsSync(this.backupDir)) {
      return [];
    }

    const files = fs
      .readdirSync(this.backupDir)
      .filter((f) => f.startsWith("hamh-") && f.endsWith(".zip"));

    return files
      .map((filename) => {
        try {
          const stat = fs.statSync(path.join(this.backupDir, filename));
          const parsed = this.parseFilename(filename);
          return {
            filename,
            version: parsed.version,
            createdAt: stat.mtime.toISOString(),
            sizeBytes: stat.size,
            auto: parsed.auto,
          };
        } catch {
          return null;
        }
      })
      .filter((m): m is BackupMetadata => m !== null)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
  }

  getBackupPath(filename: string): string | null {
    if (filename.includes("..") || filename.includes("/")) {
      return null;
    }
    const filepath = path.join(this.backupDir, filename);
    if (!fs.existsSync(filepath)) {
      return null;
    }
    return filepath;
  }

  deleteBackup(filename: string): boolean {
    const filepath = this.getBackupPath(filename);
    if (!filepath) return false;
    try {
      fs.unlinkSync(filepath);
      this.log.info(`Backup deleted: ${filename}`);
      return true;
    } catch (e) {
      this.log.error(`Failed to delete backup ${filename}:`, e);
      return false;
    }
  }

  private async enforceRetention(): Promise<void> {
    const settings = this.settingsStorage.backupSettings;
    const maxCount = settings.backupRetentionCount;
    if (maxCount <= 0) return;

    const backups = this.listBackups();
    if (backups.length <= maxCount) return;

    const toDelete = backups.slice(maxCount);
    for (const backup of toDelete) {
      this.deleteBackup(backup.filename);
    }

    if (toDelete.length > 0) {
      this.log.info(
        `Retention: deleted ${toDelete.length} old backup(s), keeping ${maxCount}`,
      );
    }
  }

  private parseFilename(filename: string): { version: string; auto: boolean } {
    // hamh-auto-2.0.33-2026-03-11_08-34-12.zip
    // hamh-manual-2.0.33-2026-03-11_08-34-12.zip
    const auto = filename.startsWith("hamh-auto-");
    const withoutPrefix = filename
      .replace(/^hamh-(auto|manual)-/, "")
      .replace(/\.zip$/, "");
    // version is everything before the date pattern (YYYY-MM-DD_HH-mm-ss)
    const dateMatch = withoutPrefix.match(
      /^(.+)-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})$/,
    );
    const version = dateMatch ? dateMatch[1] : withoutPrefix;
    return { version, auto };
  }
}
