import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unzipper from "unzipper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettingsStorage } from "../storage/app-settings-storage.js";
import {
  BRIDGE_SCHEMA_VERSION,
  type BridgeStorage,
} from "../storage/bridge-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BackupService } from "./backup-service.js";

const bridgeStorage = { bridges: [] } as unknown as BridgeStorage;
const mappingStorage = {
  getMappingsForBridge: () => [],
} as unknown as EntityMappingStorage;
function createService(
  storageLocation: string,
  backupRetentionCount = 5,
  bridges = bridgeStorage,
) {
  const settingsStorage = {
    backupSettings: { autoBackup: true, backupRetentionCount },
  } as unknown as AppSettingsStorage;
  return new BackupService(bridges, mappingStorage, settingsStorage, {
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
    vi.restoreAllMocks();
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
    const metadata = await service.createBackup(true);
    const files = fs.readdirSync(backupDir);
    expect(files).toHaveLength(5);
    expect(files).toContain(metadata.filename);
  });

  it("never prunes manual backups", async () => {
    const manual = path.join(
      backupDir,
      "hamh-manual-2.0.56-2026-08-01_00-00-00.zip",
    );
    fs.writeFileSync(manual, "x");
    fs.utimesSync(manual, new Date(2026, 7, 1), new Date(2026, 7, 1));
    seed(7);
    const service = createService(storageLocation);
    await service.createBackup(false);
    const files = fs.readdirSync(backupDir);
    expect(files.filter((f) => f.startsWith("hamh-auto-"))).toHaveLength(5);
    expect(files.filter((f) => f.startsWith("hamh-manual-"))).toHaveLength(2);
  });

  it("keeps every backup when the stored count is not a positive integer", () => {
    seed(7);
    createService(storageLocation, "abc" as unknown as number);
    expect(fs.readdirSync(backupDir)).toHaveLength(7);
  });

  it("rejects and cleans up when the archive cannot be written", async () => {
    const service = createService(storageLocation);
    const createWriteStream = fs.createWriteStream;
    vi.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
      const stream = createWriteStream(file, options);
      stream.once("open", () => stream.destroy(new Error("ENOSPC")));
      return stream;
    });
    await expect(service.createBackup(false)).rejects.toThrow("ENOSPC");
    expect(fs.readdirSync(backupDir)).toHaveLength(0);
  });

  it("only hands out backup archives", async () => {
    const service = createService(storageLocation);
    const { filename } = await service.createBackup(false);
    expect(service.getBackupPath(filename)).toBe(
      path.join(backupDir, filename),
    );
    expect(service.getBackupPath(".")).toBeNull();
    expect(service.getBackupPath("")).toBeNull();
  });

  it("archives lock PINs, login, entity identities and plugin configs", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    fs.mkdirSync(path.join(storageLocation, "app"));
    for (const name of [
      "settings.data",
      "lock-credentials.data",
      "entity-identities.data",
      "bridges.ids",
    ]) {
      fs.writeFileSync(path.join(storageLocation, "app", name), "{}");
    }
    fs.writeFileSync(
      path.join(storageLocation, `plugin-${id}-vesync.json`),
      "{}",
    );
    fs.writeFileSync(
      path.join(storageLocation, "plugin-other-vesync.json"),
      "{}",
    );
    const service = createService(storageLocation, 5, {
      bridges: [{ id, name: "B", port: 5540 }],
    } as unknown as BridgeStorage);
    const { filename } = await service.createBackup(false);
    const zip = await unzipper.Open.file(path.join(backupDir, filename));
    const names = zip.files.map((f) => f.path);
    const json = zip.files.find((f) => f.path === "backup.json");
    expect(JSON.parse(`${await json?.buffer()}`).bridgeVersion).toBe(
      BRIDGE_SCHEMA_VERSION,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "app/settings.data",
        "app/lock-credentials.data",
        "app/entity-identities.data",
        `plugins/plugin-${id}-vesync.json`,
      ]),
    );
    expect(names).not.toContain("app/bridges.ids");
    expect(names).not.toContain("plugins/plugin-other-vesync.json");
  });
});
