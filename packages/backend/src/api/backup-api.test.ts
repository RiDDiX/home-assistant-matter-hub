import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import archiver from "archiver";
import express from "express";
import unzipper from "unzipper";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BackupService } from "../services/backup/backup-service.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { AppSettingsStorage } from "../services/storage/app-settings-storage.js";
import type { BridgeStorage } from "../services/storage/bridge-storage.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import { backupApi } from "./backup-api.js";

// #439 review: the manager's per-bridge plugin-state file lives at the storage
// root, outside the identity directory the backup archives, so it has to be
// carried explicitly or a clean restore forgets which plugins were disabled.

const dir = mkdtempSync(join(tmpdir(), "hamh-backup-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A restore that brings back app files sends a real SIGTERM 500 ms later,
// which kills the test worker when the file runs slow.
const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
afterAll(() => kill.mockRestore());

const ID = "0123456789abcdef0123456789abcdef";
const bridgeStorage = {
  bridges: [{ id: ID, name: "Bridge One", port: 5540, basicInformation: {} }],
  add: async () => {},
} as unknown as BridgeStorage;
const noBridges = {
  bridges: [],
  get: () => undefined,
} as unknown as BridgeService;
const mappingStorage = {
  getMappingsForBridge: () => [],
  setMapping: async () => {},
} as unknown as EntityMappingStorage;

const noIdentities = {
  flush: async () => {},
} as unknown as EntityIdentityStorage;

async function withRouter(
  fn: (base: string) => Promise<void>,
  settingsStorage = {} as unknown as AppSettingsStorage,
  bridgeService = noBridges,
  storage = bridgeStorage,
  storageLocation = dir,
  identityStorage = noIdentities,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(
    "/backup",
    backupApi(
      storage,
      mappingStorage,
      storageLocation,
      {} as unknown as BackupService,
      settingsStorage,
      bridgeService,
      identityStorage,
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
    const stateFile = join(dir, `plugin-state-${ID}.json`);
    writeFileSync(stateFile, JSON.stringify({ camera: false }));
    const configFile = join(dir, `plugin-${ID}-vesync.json`);
    writeFileSync(configFile, JSON.stringify({ password: "p" }));
    const lockFile = join(dir, "app", "lock-credentials.data");
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(lockFile, "pins");
    await withRouter(async (base) => {
      const res = await fetch(`${base}/backup/download?includeIdentity=true`);
      expect(res.status).toBe(200);
      const zip = Buffer.from(await res.arrayBuffer());

      // The clean restore: the disabled state is gone from disk.
      unlinkSync(stateFile);
      unlinkSync(configFile);
      unlinkSync(lockFile);

      const form = new FormData();
      form.append("file", new Blob([zip]), "backup.zip");
      form.append(
        "options",
        JSON.stringify({ overwriteExisting: true, restoreAppData: true }),
      );
      const restore = await fetch(`${base}/backup/restore`, {
        method: "POST",
        body: form,
      });
      expect(restore.status).toBe(200);

      expect(existsSync(stateFile)).toBe(true);
      expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({
        camera: false,
      });
      expect(readFileSync(configFile, "utf-8")).toContain("password");
      expect(readFileSync(lockFile, "utf-8")).toBe("pins");
    });
  });
});

describe("backup settings validation", () => {
  it("rejects values the settings form cannot send and stores valid ones", async () => {
    const stored: unknown[] = [];
    const settingsStorage = {
      backupSettings: { autoBackup: true, backupRetentionCount: 5 },
      setBackupSettings: async (next: unknown) => {
        stored.push(next);
      },
    } as unknown as AppSettingsStorage;
    await withRouter(async (base) => {
      const put = (body: unknown) =>
        fetch(`${base}/backup/settings`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      for (const body of [
        { backupRetentionCount: "abc" },
        { backupRetentionCount: 0 },
        { backupRetentionCount: 2.5 },
        { backupRetentionCount: 101 },
        { backupRetentionCount: null },
        { autoBackup: "yes" },
      ]) {
        expect((await put(body)).status).toBe(400);
      }
      expect(stored).toHaveLength(0);

      expect((await put({ backupRetentionCount: 3, extra: 1 })).status).toBe(
        200,
      );
      expect(stored).toEqual([{ backupRetentionCount: 3 }]);
    }, settingsStorage);
  });
});

describe("mapping restore keeps every field", () => {
  // These were missing from the hand-written restore lists before.
  const mapping = {
    entityId: "vacuum.robo",
    customName: "Robo",
    customProductName: "S8",
    customVendorName: "Roborock",
    customSerialNumber: "SN1",
    customVendorId: 4660,
    chargingStateEntity: "binary_sensor.robo_charging",
    currentRoomEntity: "sensor.robo_room",
    cleanedAreaEntity: "sensor.robo_area",
    disableCustomAreaRoomModes: true,
    coverExposeAsDimmableLight: true,
    selectExposeAsSwitch: true,
    selectSwitchOnOption: "on",
    selectSwitchOffOption: "off",
    updateThrottleMs: 500,
    climateKeepModeOnIdle: true,
    climateForceTurnOn: true,
    climateExposeFan: true,
    fanRestoreSpeedOnPowerOn: true,
  };

  it.each(["upload", "snapshot"])("via %s restore", async (path) => {
    const restored: unknown[] = [];
    const storage = {
      getMappingsForBridge: () => [mapping],
      restoreMappings: async (
        _id: string,
        requests: unknown[],
        save: () => Promise<void>,
      ) => {
        await save();
        restored.push(...requests);
      },
    } as unknown as EntityMappingStorage;
    const zipPath = join(dir, `mappings-${path}.zip`);
    const app = express();
    app.use(express.json());
    app.use(
      "/backup",
      backupApi(
        bridgeStorage,
        storage,
        dir,
        { getBackupPath: () => zipPath } as unknown as BackupService,
        {} as unknown as AppSettingsStorage,
        noBridges,
        noIdentities,
      ),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const zip = Buffer.from(
        await (await fetch(`${base}/backup/download`)).arrayBuffer(),
      );
      let res: Response;
      if (path === "upload") {
        const form = new FormData();
        form.append("file", new Blob([zip]), "backup.zip");
        form.append("options", JSON.stringify({ overwriteExisting: true }));
        res = await fetch(`${base}/backup/restore`, {
          method: "POST",
          body: form,
        });
      } else {
        writeFileSync(zipPath, zip);
        res = await fetch(`${base}/backup/snapshots/x.zip/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ overwriteExisting: true }),
        });
      }
      expect(res.status).toBe(200);
      expect(restored).toEqual([{ ...mapping, bridgeId: ID }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function zipOf(entries: Record<string, string>): Promise<Blob> {
  const archive = archiver("zip");
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  for (const [name, content] of Object.entries(entries)) {
    archive.append(content, { name });
  }
  await archive.finalize();
  return new Blob([Buffer.concat(chunks)]);
}

function restoreForm(zip: Blob, options: object = {}) {
  const form = new FormData();
  form.append("file", zip, "backup.zip");
  form.append(
    "options",
    JSON.stringify({ overwriteExisting: true, ...options }),
  );
  return { method: "POST", body: form };
}

describe("restore input checks", () => {
  it("refuses a bridge id that leaves the storage directory", async () => {
    const legacyId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const storageLocation = join(dir, "a", "b");
    mkdirSync(storageLocation, { recursive: true });
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: [
          { id: "../../x", name: "Evil", port: 5540 },
          { id: legacyId, name: "Legacy", port: 5541, basicInformation: {} },
        ],
        entityMappings: {},
        includesIdentity: true,
      }),
      "identity/../../x/keys": "k",
      [`identity/${legacyId}/keys`]: "k",
    });
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/backup/restore`, restoreForm(zip));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.bridgesRestored).toBe(1);
        expect(
          body.errors.map((e: { bridgeId: string }) => e.bridgeId),
        ).toEqual(["../../x"]);
        expect(existsSync(join(dir, "x"))).toBe(false);
        expect(existsSync(join(storageLocation, legacyId, "keys"))).toBe(true);
      },
      undefined,
      undefined,
      undefined,
      storageLocation,
    );
  });

  it("migrates bridges from an older bridge schema", async () => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridgeVersion: 5,
        bridges: [
          {
            id: ID,
            name: "Old",
            port: 5540,
            basicInformation: {},
            featureFlags: {
              omitEventsInPriming: true,
              autoBatteryMapping: true,
            },
          },
        ],
        entityMappings: {},
      }),
    });
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/backup/restore`, restoreForm(zip));
        expect(res.status).toBe(200);
      },
      undefined,
      undefined,
      storage,
    );
    expect(added.map((b) => b.featureFlags)).toEqual([
      { autoBatteryMapping: true },
    ]);
  });

  it("refuses a bridge without basic information and a null entry", async () => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: [
          { id: "handmade", name: "Hand", port: 5540 },
          { id: "nulled", name: "N", port: 5541, basicInformation: null },
          null,
          { id: ID, name: "Bridge One", port: 5542, basicInformation: {} },
        ],
        entityMappings: {},
      }),
    });
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/backup/restore`, restoreForm(zip));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.bridgesRestored).toBe(1);
        expect(
          body.errors.map((e: { bridgeId?: string }) => e.bridgeId),
        ).toEqual(["handmade", "nulled", undefined]);
      },
      undefined,
      undefined,
      storage,
    );
    expect(added.map((b) => b.id)).toEqual([ID]);
  });

  it("rejects a backup.json larger than 50 MB", async () => {
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValueOnce({
      files: [
        {
          path: "backup.json",
          type: "File",
          uncompressedSize: 60 * 1024 * 1024,
          buffer: async () => Buffer.from("{}"),
        },
      ],
    } as unknown as unzipper.CentralDirectory);
    await withRouter(async (base) => {
      const res = await fetch(
        `${base}/backup/restore/preview`,
        restoreForm(new Blob(["zip"])),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/50 MB/);
    });
  });

  it("rejects an entry that inflates past its declared size", async () => {
    const stream = vi.fn(() =>
      Readable.from([
        Buffer.alloc(30 * 1024 * 1024),
        Buffer.alloc(30 * 1024 * 1024),
      ]),
    );
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValueOnce({
      files: [
        { path: "backup.json", type: "File", uncompressedSize: 2, stream },
      ],
    } as unknown as unzipper.CentralDirectory);
    await withRouter(async (base) => {
      const res = await fetch(
        `${base}/backup/restore/preview`,
        restoreForm(new Blob(["zip"])),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/50 MB/);
    });
    expect(stream).toHaveBeenCalledOnce();
  });

  it("rejects entries that inflate together past the archive cap", async () => {
    const backupJson = JSON.stringify({
      version: 2,
      bridges: [
        { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
      ],
      entityMappings: {},
      includesIdentity: true,
    });
    const entry = (path: string, content: Buffer, declared: number) => ({
      path,
      type: "File",
      uncompressedSize: declared,
      stream: () => Readable.from([content]),
    });
    // the declared sizes stay under the cap, the last entry lies
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValueOnce({
      files: [
        entry("backup.json", Buffer.from(backupJson), 2),
        ...["a", "b", "c", "d"].map((n) =>
          entry(`identity/${ID}/${n}`, Buffer.from("k"), 45 * 1024 * 1024),
        ),
        entry(`identity/${ID}/e`, Buffer.alloc(25 * 1024 * 1024), 1),
      ],
    } as unknown as unzipper.CentralDirectory);
    const storageLocation = join(dir, "total-cap");
    mkdirSync(storageLocation, { recursive: true });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(new Blob(["zip"])),
        );
        const body = await res.json();
        expect(body.errors[0].error).toMatch(/200 MB/);
      },
      undefined,
      undefined,
      undefined,
      storageLocation,
    );
  });

  it("rejects declared sizes over the archive cap before writing anything", async () => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    const backupJson = JSON.stringify({
      version: 2,
      bridges: [
        { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
      ],
      entityMappings: {},
      includesIdentity: true,
    });
    const entry = (path: string, content: string) => ({
      path,
      type: "File",
      uncompressedSize: 45 * 1024 * 1024,
      stream: () => Readable.from([Buffer.from(content)]),
    });
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValueOnce({
      files: [
        entry("backup.json", backupJson),
        ...["a", "b", "c", "d"].map((n) => entry(`identity/${ID}/${n}`, "k")),
      ],
    } as unknown as unzipper.CentralDirectory);
    const storageLocation = join(dir, "declared-cap");
    mkdirSync(storageLocation, { recursive: true });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(new Blob(["zip"])),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/200 MB/);
      },
      undefined,
      undefined,
      storage,
      storageLocation,
    );
    expect(added).toEqual([]);
    expect(readdirSync(storageLocation)).toEqual([]);
  });

  it("ignores Object.prototype members for a bridge id like __proto__", async () => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    // raw JSON, an object literal would set the prototype instead of a key
    const zip = await zipOf({
      "backup.json": `{"version":2,"bridges":[{"id":"__proto__","name":"P","port":5540},{"id":"constructor","name":"C","port":5541,"basicInformation":{}}],"entityMappings":{"__proto__":{"entityId":"light.x"}}}`,
    });
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/backup/restore`, restoreForm(zip));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.bridgesRestored).toBe(1);
        expect(
          body.errors.map((e: { bridgeId: string }) => e.bridgeId),
        ).toEqual(["__proto__"]);
      },
      undefined,
      undefined,
      storage,
    );
    expect(added.map((b) => b.id)).toEqual(["constructor"]);
  });

  it("refuses an entry whose size field reads 0xffffffff without zip64 data", async () => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    const zip = Buffer.from(
      await (
        await zipOf({
          "backup.json": JSON.stringify({
            version: 2,
            bridges: [
              { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
            ],
            entityMappings: {},
            includesIdentity: true,
          }),
          [`identity/${ID}/keys`]: "k",
        })
      ).arrayBuffer(),
    );
    // uncompressed size of the last central directory header
    const header = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0xffffffff, header + 24);
    const storageLocation = join(dir, "size-ffffffff");
    mkdirSync(storageLocation, { recursive: true });
    await withRouter(
      async (base) => {
        for (const route of ["restore", "restore/preview"]) {
          const res = await fetch(
            `${base}/backup/${route}`,
            restoreForm(new Blob([zip])),
          );
          expect(res.status).toBe(400);
          expect((await res.json()).error).toMatch(/Invalid backup/);
        }
      },
      undefined,
      undefined,
      storage,
      storageLocation,
    );
    expect(added).toEqual([]);
    expect(readdirSync(storageLocation)).toEqual([]);
  });

  it.each([
    undefined,
    Number.NaN,
    -5,
    "300000000",
  ])("refuses a declared size of %s", async (size) => {
    const added: BridgeData[] = [];
    const storage = {
      bridges: [],
      add: async (bridge: BridgeData) => {
        added.push(bridge);
      },
    } as unknown as BridgeStorage;
    const backupJson = JSON.stringify({
      version: 2,
      bridges: [
        { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
      ],
      entityMappings: {},
      includesIdentity: true,
    });
    vi.spyOn(unzipper.Open, "buffer").mockResolvedValueOnce({
      files: [
        {
          path: "backup.json",
          type: "File",
          uncompressedSize: backupJson.length,
          stream: () => Readable.from([Buffer.from(backupJson)]),
        },
        {
          path: `identity/${ID}/keys`,
          type: "File",
          uncompressedSize: size,
          stream: () => Readable.from([Buffer.from("k")]),
        },
      ],
    } as unknown as unzipper.CentralDirectory);
    const storageLocation = join(dir, `bad-size-${String(size)}`);
    mkdirSync(storageLocation, { recursive: true });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(new Blob(["zip"])),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/Invalid backup/);
      },
      undefined,
      undefined,
      storage,
      storageLocation,
    );
    expect(added).toEqual([]);
    expect(readdirSync(storageLocation)).toEqual([]);
  });

  it("previews a bridge id like constructor with no mappings", async () => {
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: [{ id: "constructor", name: "C", port: 5540 }],
        entityMappings: {},
      }),
    });
    await withRouter(async (base) => {
      const res = await fetch(
        `${base}/backup/restore/preview`,
        restoreForm(zip),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bridges[0]).toMatchObject({
        hasMappings: false,
        mappingCount: 0,
      });
    });
  });
});

describe("restore staging", () => {
  const backupJson = JSON.stringify({
    version: 2,
    bridges: bridgeStorage.bridges,
    entityMappings: {},
    includesIdentity: true,
  });

  it("removes stale staging folders at start and keeps recovery files", async () => {
    const storageLocation = join(dir, "sweep");
    const stale = join(storageLocation, ".restore-Ab12Cd");
    const kept = join(storageLocation, ".restore-failed-Ab12Cd");
    mkdirSync(join(stale, "previous"), { recursive: true });
    writeFileSync(join(stale, "previous", "keys"), "secret");
    mkdirSync(kept, { recursive: true });
    await withRouter(
      async () => {},
      undefined,
      undefined,
      undefined,
      storageLocation,
    );
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("replaces a file where hard links are not supported", async () => {
    const storageLocation = join(dir, "no-links");
    const keys = join(storageLocation, ID, "keys");
    mkdirSync(join(storageLocation, ID), { recursive: true });
    writeFileSync(keys, "original");
    const link = vi.spyOn(fs, "linkSync").mockImplementation(() => {
      throw new Error("EPERM: operation not permitted, link");
    });
    const zip = await zipOf({
      "backup.json": backupJson,
      [`identity/${ID}/keys`]: "replacement",
    });
    try {
      await withRouter(
        async (base) => {
          const res = await fetch(`${base}/backup/restore`, restoreForm(zip));
          expect(await res.json()).toMatchObject({
            bridgesRestored: 1,
            errors: [],
          });
        },
        undefined,
        undefined,
        undefined,
        storageLocation,
      );
      expect(link).toHaveBeenCalled();
    } finally {
      link.mockRestore();
    }
    expect(readFileSync(keys, "utf-8")).toBe("replacement");
  });

  it("reports app-wide data as not restored when a bridge fails", async () => {
    const storageLocation = join(dir, "app-skipped");
    mkdirSync(join(storageLocation, "app"), { recursive: true });
    const settingsFile = join(storageLocation, "app", "settings.data");
    writeFileSync(settingsFile, '{"current":true}');
    const storage = {
      ...bridgeStorage,
      add: vi.fn().mockRejectedValue(new Error("cannot save bridge")),
    } as unknown as BridgeStorage;
    const zip = await zipOf({
      "backup.json": backupJson,
      "app/settings.data": "{}",
    });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(zip, { restoreAppData: true }),
        );
        expect(await res.json()).toMatchObject({
          restarting: false,
          errors: [
            { bridgeId: ID, error: "cannot save bridge" },
            {
              bridgeId: "app",
              error: "App-wide data was not restored because a bridge failed",
            },
          ],
        });
      },
      undefined,
      undefined,
      storage,
      storageLocation,
    );
    expect(readFileSync(settingsFile, "utf-8")).toBe('{"current":true}');
  });
});

describe("restore while the bridge runs", () => {
  it("leaves app-wide data alone when the selected bridge is skipped", async () => {
    const storageLocation = join(dir, "selective");
    mkdirSync(join(storageLocation, "app"), { recursive: true });
    const settingsFile = join(storageLocation, "app", "settings.data");
    writeFileSync(settingsFile, '{"current":true}');
    const live = { data: { status: "running" }, stop: vi.fn() };
    const bridgeService = {
      bridges: [live],
      get: () => live,
    } as unknown as BridgeService;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: bridgeStorage.bridges,
        entityMappings: {},
        includesIdentity: true,
      }),
      "app/settings.data": "{}",
    });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(zip, { bridgeIds: [ID], overwriteExisting: false }),
        );
        expect(await res.json()).toMatchObject({
          bridgesRestored: 0,
          bridgesSkipped: 1,
          restarting: false,
        });
      },
      undefined,
      bridgeService,
      undefined,
      storageLocation,
    );
    expect(live.stop).not.toHaveBeenCalled();
    expect(readFileSync(settingsFile, "utf-8")).toBe('{"current":true}');
  });

  it("stages files before stopping a bridge and rolls them back if storage fails", async () => {
    const storageLocation = join(dir, "rollback");
    const identityDir = join(storageLocation, ID);
    const original = join(identityDir, "keys");
    const added = join(identityDir, "new-keys");
    mkdirSync(added, { recursive: true });
    writeFileSync(original, "original");
    const data = { status: "running" };
    const live = {
      data,
      stop: vi.fn(async () => {
        data.status = "stopped";
      }),
      start: vi.fn(async () => {
        data.status = "running";
      }),
    };
    const bridgeService = {
      bridges: [live],
      get: () => live,
    } as unknown as BridgeService;
    const add = vi.fn().mockRejectedValue(new Error("cannot save bridge"));
    const storage = { ...bridgeStorage, add } as unknown as BridgeStorage;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: storage.bridges,
        entityMappings: {},
        includesIdentity: true,
      }),
      [`identity/${ID}/keys`]: "replacement",
      [`identity/${ID}/new-keys`]: "new",
    });
    await withRouter(
      async (base) => {
        const restore = () => fetch(`${base}/backup/restore`, restoreForm(zip));
        expect(await (await restore()).json()).toMatchObject({
          bridgesRestored: 0,
          restartRequired: false,
        });
        expect(live.stop).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();

        rmSync(added, { recursive: true });
        expect(await (await restore()).json()).toMatchObject({
          bridgesRestored: 0,
          restartRequired: false,
          errors: [{ bridgeId: ID, error: "cannot save bridge" }],
        });
        expect(live.stop).toHaveBeenCalledOnce();
        expect(live.start).toHaveBeenCalledOnce();
        expect(readFileSync(original, "utf-8")).toBe("original");
        expect(existsSync(added)).toBe(false);
      },
      undefined,
      bridgeService,
      storage,
      storageLocation,
    );
  });

  it("stops every running bridge, restores the app files and restarts", async () => {
    kill.mockClear();
    const storageLocation = join(dir, "running-all");
    mkdirSync(storageLocation, { recursive: true });
    const settingsFile = join(storageLocation, "app", "settings.data");
    // the pending identity write has to land before the restored files
    const flush = vi.fn(async () => {
      expect(existsSync(settingsFile)).toBe(false);
    });
    const data = { status: "running" };
    const other = {
      data,
      stop: vi.fn(async () => {
        data.status = "stopped";
      }),
    };
    const bridgeService = {
      bridges: [other],
      get: () => undefined,
    } as unknown as BridgeService;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: [],
        entityMappings: {},
        includesIdentity: true,
      }),
      "app/settings.data": "{}",
    });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(zip, { restoreAppData: true }),
        );
        const body = await res.json();
        expect(body.errors).toEqual([]);
        expect(body.restartRequired).toBe(true);
        expect(body.restarting).toBe(true);
      },
      undefined,
      bridgeService,
      undefined,
      storageLocation,
      { flush } as unknown as EntityIdentityStorage,
    );
    expect(other.stop).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(readFileSync(settingsFile, "utf-8")).toBe("{}");
    await vi.waitFor(() =>
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM"),
    );
  });

  it("keeps the app files when a bridge does not stop", async () => {
    const storageLocation = join(dir, "running");
    mkdirSync(storageLocation, { recursive: true });
    const order: string[] = [];
    const live = {
      data: { status: "running" },
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    const bridgeService = {
      bridges: [live],
      get: () => undefined,
    } as unknown as BridgeService;
    const storage = {
      bridges: [
        { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
      ],
      add: async () => {
        order.push("add");
      },
    } as unknown as BridgeStorage;
    const zip = await zipOf({
      "backup.json": JSON.stringify({
        version: 2,
        bridges: [
          { id: ID, name: "Bridge One", port: 5540, basicInformation: {} },
        ],
        entityMappings: {},
        includesIdentity: true,
      }),
      "app/settings.data": "{}",
    });
    await withRouter(
      async (base) => {
        const res = await fetch(
          `${base}/backup/restore`,
          restoreForm(zip, { restoreAppData: true }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.bridgesRestored).toBe(1);
        expect(
          body.errors.map((e: { bridgeId: string }) => e.bridgeId),
        ).toEqual(["app"]);
      },
      undefined,
      bridgeService,
      storage,
      storageLocation,
    );
    expect(order).toEqual(["add", "stop"]);
    expect(existsSync(join(storageLocation, "app", "settings.data"))).toBe(
      false,
    );
  });
});
