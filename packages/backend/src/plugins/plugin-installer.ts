import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@matter/general";

const logger = Logger.get("PluginInstaller");

// Validate package name to prevent command injection
const VALID_PACKAGE_RE =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^@\s]+)?$/;

export interface InstallResult {
  success: boolean;
  packageName: string;
  version?: string;
  error?: string;
}

/**
 * Installs/uninstalls npm packages into a dedicated plugin directory
 * inside the HAMH storage location.
 */
export class PluginInstaller {
  private readonly pluginDir: string;

  constructor(storageLocation: string) {
    this.pluginDir = path.join(storageLocation, "plugin-packages");
    this.ensurePluginDir();
  }

  get installDir(): string {
    return this.pluginDir;
  }

  private ensurePluginDir(): void {
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
    }
    // Ensure a package.json exists so npm install works
    const pkgJson = path.join(this.pluginDir, "package.json");
    if (!fs.existsSync(pkgJson)) {
      fs.writeFileSync(
        pkgJson,
        JSON.stringify(
          {
            name: "hamh-plugins",
            version: "1.0.0",
            private: true,
            description: "HAMH installed plugins",
          },
          null,
          2,
        ),
      );
    }
  }

  async install(packageName: string): Promise<InstallResult> {
    if (!VALID_PACKAGE_RE.test(packageName)) {
      return {
        success: false,
        packageName,
        error: `Invalid package name: "${packageName}"`,
      };
    }

    logger.info(`Installing plugin: ${packageName}`);

    return new Promise((resolve) => {
      execFile(
        "npm",
        ["install", packageName, "--save"],
        {
          cwd: this.pluginDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: "production" },
        },
        (error, _stdout, stderr) => {
          if (error) {
            logger.error(
              `Failed to install ${packageName}:`,
              stderr || error.message,
            );
            resolve({
              success: false,
              packageName,
              error: stderr || error.message,
            });
            return;
          }

          // Try to read the installed version
          const version = this.getInstalledVersion(packageName);
          logger.info(`Installed ${packageName}@${version || "unknown"}`);
          resolve({
            success: true,
            packageName,
            version: version ?? undefined,
          });
        },
      );
    });
  }

  async uninstall(packageName: string): Promise<InstallResult> {
    if (!VALID_PACKAGE_RE.test(packageName)) {
      return {
        success: false,
        packageName,
        error: `Invalid package name: "${packageName}"`,
      };
    }

    logger.info(`Uninstalling plugin: ${packageName}`);

    return new Promise((resolve) => {
      execFile(
        "npm",
        ["uninstall", packageName, "--save"],
        {
          cwd: this.pluginDir,
          timeout: 60_000,
        },
        (error, _stdout, stderr) => {
          if (error) {
            logger.error(
              `Failed to uninstall ${packageName}:`,
              stderr || error.message,
            );
            resolve({
              success: false,
              packageName,
              error: stderr || error.message,
            });
            return;
          }
          logger.info(`Uninstalled ${packageName}`);
          resolve({ success: true, packageName });
        },
      );
    });
  }

  /**
   * Get the resolved path to a plugin's main entry point.
   * This is used by PluginManager.loadExternal() to import the plugin.
   */
  getPluginPath(packageName: string): string {
    return path.join(this.pluginDir, "node_modules", packageName);
  }

  /**
   * List all installed plugin packages from the plugin directory's package.json.
   */
  listInstalled(): Array<{ name: string; version: string }> {
    try {
      const pkgJson = path.join(this.pluginDir, "package.json");
      if (!fs.existsSync(pkgJson)) return [];
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      const deps = pkg.dependencies ?? {};
      return Object.entries(deps).map(([name, ver]) => ({
        name,
        version: this.getInstalledVersion(name) ?? String(ver),
      }));
    } catch {
      return [];
    }
  }

  async installFromTgz(tgzBuffer: Buffer): Promise<InstallResult> {
    const tgzPath = path.join(this.pluginDir, `.upload-${Date.now()}.tgz`);
    try {
      fs.writeFileSync(tgzPath, tgzBuffer);

      // Snapshot deps before install to detect what was added
      const depsBefore = new Set(Object.keys(this.readDeps()));

      const result = await this.installFromNpm(tgzPath);
      if (!result.success) return result;

      // Find the newly added package by diffing deps
      const depsAfter = this.readDeps();
      for (const name of Object.keys(depsAfter)) {
        if (!depsBefore.has(name)) {
          return {
            success: true,
            packageName: name,
            version: this.getInstalledVersion(name) ?? String(depsAfter[name]),
          };
        }
      }

      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("Failed to install from tgz:", msg);
      return { success: false, packageName: "unknown", error: msg };
    } finally {
      try {
        if (fs.existsSync(tgzPath)) fs.unlinkSync(tgzPath);
      } catch {
        // cleanup best-effort
      }
    }
  }

  private installFromNpm(target: string): Promise<InstallResult> {
    return new Promise((resolve) => {
      execFile(
        "npm",
        ["install", target, "--save"],
        {
          cwd: this.pluginDir,
          timeout: 120_000,
          env: { ...process.env, NODE_ENV: "production" },
        },
        (error, _stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              packageName: path.basename(target),
              error: stderr || error.message,
            });
            return;
          }
          resolve({
            success: true,
            packageName: path.basename(target),
          });
        },
      );
    });
  }

  private readDeps(): Record<string, string> {
    try {
      const pkgJson = path.join(this.pluginDir, "package.json");
      if (!fs.existsSync(pkgJson)) return {};
      const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"));
      return pkg.dependencies ?? {};
    } catch {
      return {};
    }
  }

  installFromLocal(localPath: string): InstallResult {
    const resolvedPath = path.resolve(localPath);
    if (!fs.existsSync(resolvedPath)) {
      return {
        success: false,
        packageName: "unknown",
        error: `Path does not exist: ${resolvedPath}`,
      };
    }

    const pkgJsonPath = path.join(resolvedPath, "package.json");
    if (!fs.existsSync(pkgJsonPath)) {
      return {
        success: false,
        packageName: "unknown",
        error: `Missing package.json in ${resolvedPath}`,
      };
    }

    let pkg: { name?: string; version?: string };
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      return {
        success: false,
        packageName: "unknown",
        error: `Invalid package.json in ${resolvedPath}`,
      };
    }

    const packageName = pkg.name;
    if (!packageName || typeof packageName !== "string") {
      return {
        success: false,
        packageName: "unknown",
        error: "Invalid package.json: missing 'name' field",
      };
    }

    const targetLink = path.join(this.pluginDir, "node_modules", packageName);
    if (fs.existsSync(targetLink)) {
      fs.rmSync(targetLink, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(targetLink), { recursive: true });
    fs.symlinkSync(resolvedPath, targetLink, "dir");

    logger.info(
      `Linked local plugin: ${packageName}@${pkg.version || "unknown"} → ${resolvedPath}`,
    );
    return {
      success: true,
      packageName,
      version: pkg.version ?? undefined,
    };
  }

  private getInstalledVersion(packageName: string): string | null {
    try {
      const pkgPath = path.join(
        this.pluginDir,
        "node_modules",
        packageName,
        "package.json",
      );
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? null;
      }
    } catch {
      // ignore
    }
    return null;
  }
}
