import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PluginInstaller, VALID_PACKAGE_RE } from "./plugin-installer.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-plugin-installer-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("VALID_PACKAGE_RE", () => {
  it("refuses version specs that point npm at a URL or a path", () => {
    expect(VALID_PACKAGE_RE.test("foo@https://evil/x.tgz")).toBe(false);
    expect(VALID_PACKAGE_RE.test("foo@file:../../x")).toBe(false);
  });

  it("accepts a scoped package with a version", () => {
    expect(VALID_PACKAGE_RE.test("@scope/name@1.2.3")).toBe(true);
  });
});

describe("installFromLocal", () => {
  it("refuses a package name that walks out of node_modules", () => {
    const installer = new PluginInstaller(path.join(dir, "storage"));
    const victim = path.join(dir, "victim");
    fs.mkdirSync(victim);
    const local = path.join(dir, "local");
    fs.mkdirSync(local);
    fs.writeFileSync(
      path.join(local, "package.json"),
      JSON.stringify({ name: "../../../victim" }),
    );

    const result = installer.installFromLocal(local);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid package name");
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(path.join(installer.installDir, "node_modules"))).toBe(
      false,
    );
  });
});
