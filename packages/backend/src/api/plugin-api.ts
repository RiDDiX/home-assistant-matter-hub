import * as nodePath from "node:path";
import express from "express";
import { BUILTIN_PLUGIN_NAMES } from "../plugins/builtin/names.js";
import { PluginInstaller } from "../plugins/plugin-installer.js";
import { PluginRegistry } from "../plugins/plugin-registry.js";
import { type PluginConfigSchema, SECRET_UNCHANGED } from "../plugins/types.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";

// Secret fields never leave the backend; the dialog round-trips the
// placeholder and updateConfig swaps the stored value back in.
function redactSecrets(
  config: Record<string, unknown>,
  schema: PluginConfigSchema | undefined,
): Record<string, unknown> {
  if (!schema) return config;
  const out = { ...config };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.secret && out[key] != null && out[key] !== "") {
      out[key] = SECRET_UNCHANGED;
    }
  }
  return out;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const BLOCKED_PREFIXES = [
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/var",
  "/sys",
  "/proc",
  "/dev",
  "/boot",
  "/root",
];

// Drop an npm version spec: "camera@1.0.0" -> "camera", "@a/b@2" -> "@a/b".
// A scoped name starts with "@", so only the last "@" can be the version there.
function packageBaseName(spec: string): string {
  const name = spec.trim();
  const at = name.startsWith("@") ? name.lastIndexOf("@") : name.indexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}

// Built-in plugins ship with the bridge. Their names are not npm packages, so
// installing one pulls an unrelated stranger off the registry (#432). The list
// is static: a bridge that never started its plugins must not open the gate.
function builtinPluginName(requested: string): string | undefined {
  const wanted = requested.trim().toLowerCase();
  return BUILTIN_PLUGIN_NAMES.find(
    (name) => name.trim().toLowerCase() === wanted,
  );
}

export function pluginApi(
  bridgeService: BridgeService,
  storageLocation: string,
) {
  const router = express.Router();
  const installer = new PluginInstaller(storageLocation);
  const registry = new PluginRegistry(storageLocation);

  /**
   * GET /api/plugins
   * Returns all plugins across all bridges with metadata, devices, and circuit breaker state.
   */
  router.get("/", (_req, res) => {
    const result: Array<{
      bridgeId: string;
      bridgeName: string;
      plugins: Array<{
        name: string;
        version: string;
        source: string;
        enabled: boolean;
        config: Record<string, unknown>;
        circuitBreaker?: {
          failures: number;
          disabled: boolean;
          lastError?: string;
          disabledAt?: number;
        };
        devices: Array<{
          id: string;
          name: string;
          deviceType: string;
        }>;
      }>;
    }> = [];

    for (const bridge of bridgeService.bridges) {
      // Server mode bridges host no plugins and have no pluginInfo (#430).
      const info = bridge.pluginInfo;
      if (!info) continue;
      const plugins = info.metadata.map((meta) => ({
        name: meta.name,
        version: meta.version,
        source: meta.source,
        enabled: meta.enabled,
        config: redactSecrets(
          meta.config,
          bridge.getPluginConfigSchema?.(meta.name),
        ),
        circuitBreaker: info.circuitBreakers[meta.name],
        devices: info.devices
          .filter((d) => d.pluginName === meta.name)
          .map((d) => ({
            id: d.device.id,
            name: d.device.name,
            // custom endpointType devices have no built-in deviceType key
            deviceType: d.device.deviceType ?? "custom",
          })),
      }));

      result.push({
        bridgeId: bridge.id,
        bridgeName: bridge.data.name,
        plugins,
      });
    }

    res.json(result);
  });

  /**
   * POST /api/plugins/:bridgeId/:pluginName/enable
   */
  // Resolve a plugin-capable bridge or answer the request with an error.
  // Server mode bridges have none of the plugin methods (#430).
  function pluginBridge(bridgeId: string, res: express.Response) {
    const bridge = bridgeService.get(bridgeId);
    if (!bridge) {
      res.status(404).json({ error: "Bridge not found" });
      return undefined;
    }
    if (typeof bridge.enablePlugin !== "function") {
      res.status(400).json({ error: "Bridge does not support plugins" });
      return undefined;
    }
    return bridge;
  }

  router.post("/:bridgeId/:pluginName/enable", async (req, res) => {
    const bridge = pluginBridge(req.params.bridgeId, res);
    if (!bridge) return;
    const { pluginName } = req.params;
    const metadata = await bridge.enablePlugin(pluginName);
    if (!metadata) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    // The manager's resulting state, not the wish: a start the breaker
    // re-disabled reports enabled false here.
    res.json({
      success: metadata.enabled === true,
      pluginName,
      enabled: metadata.enabled,
    });
  });

  /**
   * POST /api/plugins/:bridgeId/:pluginName/disable
   */
  router.post("/:bridgeId/:pluginName/disable", async (req, res) => {
    const bridge = pluginBridge(req.params.bridgeId, res);
    if (!bridge) return;
    const { pluginName } = req.params;
    const metadata = await bridge.disablePlugin(pluginName);
    if (!metadata) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    res.json({
      success: metadata.enabled === false,
      pluginName,
      enabled: metadata.enabled,
    });
  });

  /**
   * GET /api/plugins/:bridgeId/:pluginName/config-schema
   * Get the config schema for a plugin.
   */
  router.get("/:bridgeId/:pluginName/config-schema", (req, res) => {
    const bridge = pluginBridge(req.params.bridgeId, res);
    if (!bridge) return;
    const schema = bridge.getPluginConfigSchema(req.params.pluginName);
    res.json({ pluginName: req.params.pluginName, schema: schema ?? null });
  });

  /**
   * POST /api/plugins/:bridgeId/:pluginName/config
   * Update the config for a plugin.
   * Body: { config: object }
   */
  router.post("/:bridgeId/:pluginName/config", async (req, res) => {
    const bridge = pluginBridge(req.params.bridgeId, res);
    if (!bridge) return;
    const { config } = req.body as { config?: Record<string, unknown> };
    if (!config || typeof config !== "object") {
      res.status(400).json({ error: "config object is required" });
      return;
    }
    const ok = await bridge.updatePluginConfig(req.params.pluginName, config);
    if (!ok) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }
    res.json({ success: true, pluginName: req.params.pluginName });
  });

  /**
   * POST /api/plugins/:bridgeId/:pluginName/reset
   * Reset the circuit breaker for a plugin.
   */
  router.post("/:bridgeId/:pluginName/reset", (req, res) => {
    const bridge = pluginBridge(req.params.bridgeId, res);
    if (!bridge) return;
    const { pluginName } = req.params;
    bridge.resetPlugin(pluginName);
    res.json({ success: true, pluginName, reset: true });
  });

  /**
   * GET /api/plugins/installed
   * List all installed plugin packages (from registry + npm).
   */
  router.get("/installed", (_req, res) => {
    const registered = registry.getAll();
    const npmInstalled = installer.listInstalled();

    const result = registered.map((entry) => {
      const npm = npmInstalled.find((p) => p.name === entry.packageName);
      return {
        packageName: entry.packageName,
        version: npm?.version ?? "unknown",
        config: entry.config,
        autoLoad: entry.autoLoad,
        installedAt: entry.installedAt,
        path: installer.getPluginPath(entry.packageName),
      };
    });

    res.json(result);
  });

  /**
   * POST /api/plugins/install
   * Install a plugin via npm and register it.
   * Body: { packageName: string, config?: object }
   */
  router.post("/install", async (req, res) => {
    const { packageName, config } = req.body as {
      packageName?: string;
      config?: Record<string, unknown>;
    };

    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required" });
      return;
    }

    // The version spec stays on the install call, everything else works with
    // the bare name.
    const baseName = packageBaseName(packageName);

    const builtin = builtinPluginName(baseName);
    if (builtin) {
      res.status(400).json({
        error:
          `"${builtin}" is built in and needs no installation. ` +
          "Enable and configure it on the plugins page.",
      });
      return;
    }

    try {
      const result = await installer.install(packageName);
      if (!result.success) {
        res.status(500).json({
          error: `Installation failed: ${result.error}`,
          details: result,
        });
        return;
      }

      // npm puts the package under its bare name, so the registry has to store
      // that name or the entry points at a path that does not exist.
      registry.add(baseName, config ?? {});

      res.json({
        success: true,
        packageName: baseName,
        version: result.version,
        message: "Plugin installed. Restart the bridge to load it.",
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Installation failed",
      });
    }
  });

  /**
   * POST /api/plugins/uninstall
   * Uninstall a plugin via npm and remove it from registry.
   * Body: { packageName: string }
   */
  router.post("/uninstall", async (req, res) => {
    const { packageName } = req.body as { packageName?: string };

    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required" });
      return;
    }

    try {
      const result = await installer.uninstall(packageName);
      if (!result.success) {
        res.status(500).json({
          error: `Uninstall failed: ${result.error}`,
          details: result,
        });
        return;
      }

      registry.remove(packageName);

      res.json({
        success: true,
        packageName,
        message: "Plugin uninstalled. Restart the bridge to apply changes.",
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Uninstall failed",
      });
    }
  });

  /**
   * POST /api/plugins/upload
   * Install a plugin from an uploaded .tgz file.
   * Expects raw binary body with Content-Type: application/gzip or application/octet-stream.
   */
  router.post("/upload", async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > MAX_UPLOAD_BYTES) {
          res.status(413).json({
            error: `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`,
          });
          return;
        }
        chunks.push(buf);
      }
      const tgzBuffer = Buffer.concat(chunks);

      if (tgzBuffer.length === 0) {
        res.status(400).json({ error: "Empty upload body" });
        return;
      }

      const result = await installer.installFromTgz(tgzBuffer);
      if (!result.success) {
        res.status(500).json({
          error: `Upload install failed: ${result.error}`,
          details: result,
        });
        return;
      }

      const reservedUpload = builtinPluginName(result.packageName);
      if (reservedUpload) {
        res.status(400).json({
          error: `"${reservedUpload}" is built in and needs no installation. Enable and configure it on the plugins page.`,
        });
        return;
      }

      registry.add(result.packageName, {});

      res.json({
        success: true,
        packageName: result.packageName,
        version: result.version,
        message:
          "Plugin uploaded and installed. Restart the bridge to load it.",
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  });

  /**
   * POST /api/plugins/install-local
   * Install a plugin from a local filesystem path (symlink).
   * Body: { path: string }
   */
  router.post("/install-local", (req, res) => {
    const { path: localPath } = req.body as { path?: string };

    if (!localPath || typeof localPath !== "string") {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const resolved = nodePath.resolve(localPath);
    if (BLOCKED_PREFIXES.some((p) => resolved.startsWith(p))) {
      res
        .status(400)
        .json({ error: "Path is inside a restricted system directory" });
      return;
    }

    try {
      const result = installer.installFromLocal(localPath);
      if (!result.success) {
        res.status(500).json({
          error: `Local install failed: ${result.error}`,
          details: result,
        });
        return;
      }

      const reservedLocal = builtinPluginName(result.packageName);
      if (reservedLocal) {
        res.status(400).json({
          error: `"${reservedLocal}" is built in and needs no installation. Enable and configure it on the plugins page.`,
        });
        return;
      }

      registry.add(result.packageName, {});

      res.json({
        success: true,
        packageName: result.packageName,
        version: result.version,
        message:
          "Plugin linked from local path. Restart the bridge to load it.",
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Local install failed",
      });
    }
  });

  return router;
}
