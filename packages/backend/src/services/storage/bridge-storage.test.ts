import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { StorageService } from "@matter/main";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStorage } from "./app-storage.js";
import { BridgeStorage } from "./bridge-storage.js";

let dir: string;
let appStorage: AppStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bridges-"));
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  appStorage = new AppStorage(env.get(StorageService));
  await appStorage.construction;
});

afterEach(async () => {
  await appStorage.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("BridgeStorage.add", () => {
  // bridge-service hands Bridge.data, which carries the pairing codes, so
  // they ended up in the store and in every backup.
  it("stores the config without runtime metadata", async () => {
    const storage = new BridgeStorage(appStorage);
    await storage.construction;
    await storage.add({
      id: "b1",
      name: "Bridge",
      port: 5540,
      filter: { include: [], exclude: [] },
      basicInformation: { vendorId: 1 },
      status: "running",
      statusReason: "ok",
      commissioning: { passcode: 20202021, qrPairingCode: "MT:X" },
      deviceCount: 3,
    } as unknown as BridgeData);

    const stored = (await appStorage
      .createContext("bridges")
      .get("b1")) as unknown as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      "basicInformation",
      "filter",
      "id",
      "name",
      "port",
    ]);
    expect(Object.keys(storage.bridges[0]).sort()).toEqual(
      Object.keys(stored).sort(),
    );
  });
});
