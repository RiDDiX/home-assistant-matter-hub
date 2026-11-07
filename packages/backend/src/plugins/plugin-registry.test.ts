import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PluginRegistry } from "./plugin-registry.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-plugin-registry-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("PluginRegistry", () => {
  it("keeps changes made through another instance on the same file", () => {
    const api = new PluginRegistry(dir);
    api.add("hamh-plugin-a", { a: 1 });
    const bridge = new PluginRegistry(dir);

    api.add("hamh-plugin-b");
    bridge.updateConfig("hamh-plugin-a", { a: 2 });
    api.remove("hamh-plugin-b");
    api.add("hamh-plugin-c");

    expect(bridge.getAll().map((p) => [p.packageName, p.config])).toEqual([
      ["hamh-plugin-a", { a: 2 }],
      ["hamh-plugin-c", {}],
    ]);
    expect(fs.existsSync(path.join(dir, "installed-plugins.json.tmp"))).toBe(
      false,
    );
  });
});
