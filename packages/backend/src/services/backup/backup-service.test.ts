import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppSettingsStorage } from "../storage/app-settings-storage.js";
import type { BridgeStorage } from "../storage/bridge-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BackupService } from "./backup-service.js";

const bridgeStorage = { bridges: [] } as unknown as BridgeStorage;
const mappingStorage = {
  getMappingsForBridge: () => [],
} as unknown as EntityMappingStorage;
const settingsStorage = {
  backupSettings: { autoBackup: true, backupRetentionCount: 5 },
} as unknown as AppSettingsStorage;

function createService(storageLocation: string) {
  return new BackupService(bridgeStorage, mappingStorage, settingsStorage, {
    storageLocation,
    appVersion: "2.0.56",
  });
}

describe("BackupService", () => {
  let storageLocation: string;
  let backupDir: string;

  beforeEach(() => {
    storageLocation = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-backup-"));
    backupDir = path.join(storageLocation, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(storageLocation, { recursive: true, force: true });
  });

  function seed(count: number) {
    for (let i = 0; i < count; i++) {
      const file = path.join(
        backupDir,
        `hamh-auto-2.0.56-2026-09-0${i + 1}_00-00-00.zip`,
      );
      fs.writeFileSync(file, "x");
      const mtime = new Date(2026, 8, i + 1);
      fs.utimesSync(file, mtime, mtime);
    }
  }

  it("prunes leftovers on startup, not only after a backup (#483)", () => {
    seed(9);
    createService(storageLocation);
    expect(fs.readdirSync(backupDir)).toHaveLength(5);
  });

  it("removes half-written archives on startup", () => {
    seed(2);
    fs.writeFileSync(
      path.join(backupDir, "hamh-auto-2.0.56-2026-09-09_00-00-00.zip.part"),
      "truncated",
    );
    createService(storageLocation);
    expect(
      fs.readdirSync(backupDir).filter((f) => f.endsWith(".part")),
    ).toHaveLength(0);
  });

  it("still enforces retention after a backup", async () => {
    seed(5);
    const service = createService(storageLocation);
    const metadata = await service.createBackup(false);
    const files = fs.readdirSync(backupDir);
    expect(files).toHaveLength(5);
    expect(files).toContain(metadata.filename);
  });
});
