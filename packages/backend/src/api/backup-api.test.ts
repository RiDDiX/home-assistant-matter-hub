import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import type { BackupService } from "../services/backup/backup-service.js";
import type { AppSettingsStorage } from "../services/storage/app-settings-storage.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import { backupApi } from "./backup-api.js";

// #439 review: the manager's per-bridge plugin-state file lives at the storage
// root, outside the identity directory the backup archives, so it has to be
// carried explicitly or a clean restore forgets which plugins were disabled.

const dir = mkdtempSync(join(tmpdir(), "hamh-backup-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bridgeStorage = {
  bridges: [{ id: "b1", name: "Bridge One", port: 5540 }],
  add: async () => {},
} as unknown as BridgeStorage;
const mappingStorage = {
  getMappingsForBridge: () => [],
  setMapping: async () => {},
} as unknown as EntityMappingStorage;

async function withRouter(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    "/backup",
    backupApi(
      bridgeStorage,
      mappingStorage,
      dir,
      {} as unknown as BackupService,
      {} as unknown as AppSettingsStorage,
    ),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("plugin state in backup and restore (#439 review)", () => {
  it("round-trips the plugin-state file through download and restore", async () => {
    const stateFile = join(dir, "plugin-state-b1.json");
    writeFileSync(stateFile, JSON.stringify({ camera: false }));
    await withRouter(async (base) => {
      const res = await fetch(`${base}/backup/download?includeIdentity=true`);
      expect(res.status).toBe(200);
      const zip = Buffer.from(await res.arrayBuffer());

      // The clean restore: the disabled state is gone from disk.
      unlinkSync(stateFile);

      const form = new FormData();
      form.append("file", new Blob([zip]), "backup.zip");
      form.append("options", JSON.stringify({ overwriteExisting: true }));
      const restore = await fetch(`${base}/backup/restore`, {
        method: "POST",
        body: form,
      });
      expect(restore.status).toBe(200);

      expect(existsSync(stateFile)).toBe(true);
      expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({
        camera: false,
      });
    });
  });
});
