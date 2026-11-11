import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PluginInstaller, VALID_PACKAGE_RE } from "./plugin-installer.js";

// Fake npm: "install <tgz> --save" records the dep as npm does, keyed by the
// package name with a "file:<tgz>" spec, and tracks overlapping runs.
const npm = vi.hoisted(() => ({ running: 0, maxRunning: 0 }));
vi.mock("node:child_process", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    execFile: (
      _cmd: string,
      args: string[],
      opts: { cwd: string },
      cb: (e: Error | null, out: string, err: string) => void,
    ) => {
      npm.running++;
      npm.maxRunning = Math.max(npm.maxRunning, npm.running);
      setTimeout(() => {
        const pkgPath = path.join(opts.cwd, "package.json");
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const target = args[1];
        if (args[0] === "install" && target.endsWith(".tgz")) {
          const name = fs.readFileSync(target, "utf-8");
          pkg.dependencies = {
            ...pkg.dependencies,
            [name]: `file:${path.basename(target)}`,
          };
        }
        fs.writeFileSync(pkgPath, JSON.stringify(pkg));
        npm.running--;
        cb(null, "", "");
      }, 10);
    },
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-plugin-installer-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("VALID_PACKAGE_RE", () => {
  it("refuses version specs that point npm at a URL or a path", () => {
    expect(VALID_PACKAGE_RE.test("foo@https://evil/x.tgz")).toBe(false);
    expect(VALID_PACKAGE_RE.test("foo@file:../../x")).toBe(false);
  });

  it("refuses specs npm resolves as a local file or directory", () => {
    for (const spec of [
      "foo@.",
      "foo@..",
      "foo@.x",
      "foo.tgz",
      "foo@1.tgz",
      "foo@1.TGZ",
      "foo.tar.gz",
      "foo@1.Tar.Gz",
      "foo.tar",
      "@scope/name@1.tar",
    ]) {
      expect(VALID_PACKAGE_RE.test(spec), spec).toBe(false);
    }
  });

  it("accepts a scoped package with a version", () => {
    expect(VALID_PACKAGE_RE.test("@scope/name@1.2.3")).toBe(true);
    expect(VALID_PACKAGE_RE.test("foo")).toBe(true);
    expect(VALID_PACKAGE_RE.test("foo-bar")).toBe(true);
  });

  it("accepts registry names, tags and ranges", () => {
    for (const spec of [
      "name",
      "@scope/name",
      "name@1.2.3",
      "name@latest",
      "name@~1.2",
      "name@^1",
      "name@1.x",
      "name@*",
      "name@1.0.0-rc.1",
    ]) {
      expect(VALID_PACKAGE_RE.test(spec), spec).toBe(true);
    }
  });

  it("refuses names that npm would read as flags", () => {
    expect(VALID_PACKAGE_RE.test("-g")).toBe(false);
    expect(VALID_PACKAGE_RE.test("--global")).toBe(false);
    expect(VALID_PACKAGE_RE.test("--prefix")).toBe(false);
    expect(VALID_PACKAGE_RE.test("@-scope/name")).toBe(false);
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

describe("installFromTgz", () => {
  it("names the package on a re-upload of an installed plugin", async () => {
    const installer = new PluginInstaller(path.join(dir, "tgz"));
    const tgz = Buffer.from("hamh-plugin-x");

    const first = await installer.installFromTgz(tgz);
    const second = await installer.installFromTgz(tgz);

    expect(first).toMatchObject({
      success: true,
      packageName: "hamh-plugin-x",
    });
    expect(second).toMatchObject({
      success: true,
      packageName: "hamh-plugin-x",
    });
  });

  it("runs npm one at a time and names each upload correctly", async () => {
    const installer = new PluginInstaller(path.join(dir, "tgz-parallel"));
    npm.maxRunning = 0;

    const results = await Promise.all([
      installer.installFromTgz(Buffer.from("hamh-plugin-b")),
      installer.install("hamh-plugin-a"),
      installer.installFromTgz(Buffer.from("hamh-plugin-c")),
    ]);

    expect(npm.maxRunning).toBe(1);
    expect(results.map((r) => r.packageName)).toEqual([
      "hamh-plugin-b",
      "hamh-plugin-a",
      "hamh-plugin-c",
    ]);
  });
});
