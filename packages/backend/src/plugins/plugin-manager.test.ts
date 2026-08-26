import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OnOffLightDevice } from "@matter/main/devices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_API_VERSION, PluginManager } from "./plugin-manager.js";
import type { MatterHubPlugin, PluginContext, PluginDevice } from "./types.js";

function createMockPlugin(
  overrides: Partial<MatterHubPlugin> = {},
): MatterHubPlugin {
  return {
    name: overrides.name ?? "test-plugin",
    version: overrides.version ?? "1.0.0",
    onStart: overrides.onStart ?? (async () => {}),
    onConfigure: overrides.onConfigure,
    onShutdown: overrides.onShutdown,
    getConfigSchema: overrides.getConfigSchema,
    onConfigChanged: overrides.onConfigChanged,
  };
}

describe("PluginManager", () => {
  const storageDir = `/tmp/hamh-test-plugins-${Date.now()}`;

  describe("registerBuiltIn", () => {
    it("should register a built-in plugin", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const plugin = createMockPlugin();
      await pm.registerBuiltIn(plugin);

      const metadata = pm.getMetadata();
      expect(metadata).toHaveLength(1);
      expect(metadata[0].name).toBe("test-plugin");
      expect(metadata[0].source).toBe("builtin");
      expect(metadata[0].enabled).toBe(true);
    });

    it("should reject duplicate plugin names", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      await pm.registerBuiltIn(createMockPlugin());
      await expect(pm.registerBuiltIn(createMockPlugin())).rejects.toThrow(
        "already registered",
      );
    });
  });

  describe("lifecycle", () => {
    it("should call onStart for all plugins", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const onStart = vi.fn(async () => {});
      await pm.registerBuiltIn(createMockPlugin({ onStart }));
      await pm.startAll();
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("should call onConfigure for all plugins", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const onConfigure = vi.fn(async () => {});
      await pm.registerBuiltIn(createMockPlugin({ onConfigure }));
      await pm.startAll();
      await pm.configureAll();
      expect(onConfigure).toHaveBeenCalledTimes(1);
    });

    it("should call onShutdown for all plugins", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const onShutdown = vi.fn(async () => {});
      await pm.registerBuiltIn(createMockPlugin({ onShutdown }));
      await pm.startAll();
      await pm.shutdownAll("test");
      expect(onShutdown).toHaveBeenCalledWith("test");
    });
  });

  describe("device registration", () => {
    it("should register a valid device and fire callback", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registeredDevices: Array<{ name: string; device: PluginDevice }> =
        [];
      pm.onDeviceRegistered = async (name, device) => {
        registeredDevices.push({ name, device });
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "dev-1",
              name: "Test Device",
              deviceType: "on_off_light",
              clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
            });
          },
        }),
      );

      await pm.startAll();

      expect(registeredDevices).toHaveLength(1);
      expect(registeredDevices[0].name).toBe("test-plugin");
      expect(registeredDevices[0].device.id).toBe("dev-1");
    });

    it("should register a device built from a custom endpointType", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registered: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registered.push(device);
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "custom-1",
              name: "Custom Device",
              // No deviceType: the plugin supplies its own matter.js type.
              endpointType: OnOffLightDevice,
              clusters: [],
            });
          },
        }),
      );

      await pm.startAll();
      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe("custom-1");
      expect(registered[0].endpointType).toBeDefined();
    });

    it("should reject a device with neither deviceType nor endpointType", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registered: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registered.push(device);
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "bad-1",
              name: "No Type",
              clusters: [],
            } as unknown as PluginDevice);
          },
        }),
      );

      await pm.startAll();
      expect(registered).toHaveLength(0);
    });

    it("should reject device with invalid deviceType", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registeredDevices: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registeredDevices.push(device);
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "dev-1",
              name: "Bad Device",
              deviceType: "invalid_type",
              clusters: [],
            });
          },
        }),
      );

      await pm.startAll();
      expect(registeredDevices).toHaveLength(0);
    });

    it("should reject device with empty id", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registeredDevices: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registeredDevices.push(device);
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "",
              name: "No ID",
              deviceType: "on_off_light",
              clusters: [],
            });
          },
        }),
      );

      await pm.startAll();
      expect(registeredDevices).toHaveLength(0);
    });

    it("should preserve onAttributeWrite callback on registered device", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registeredDevices: Array<{ name: string; device: PluginDevice }> =
        [];
      pm.onDeviceRegistered = async (name, device) => {
        registeredDevices.push({ name, device });
      };

      const writeLog: Array<{
        clusterId: string;
        attribute: string;
        value: unknown;
      }> = [];

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "dev-write",
              name: "Writable Device",
              deviceType: "on_off_light",
              clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
              onAttributeWrite: async (clusterId, attribute, value) => {
                writeLog.push({ clusterId, attribute, value });
              },
            });
          },
        }),
      );

      await pm.startAll();

      expect(registeredDevices).toHaveLength(1);
      const device = registeredDevices[0].device;
      expect(device.onAttributeWrite).toBeDefined();

      // Simulate what BridgeEndpointManager does when a controller writes
      await device.onAttributeWrite!("onOff", "onOff", true);
      expect(writeLog).toHaveLength(1);
      expect(writeLog[0]).toEqual({
        clusterId: "onOff",
        attribute: "onOff",
        value: true,
      });
    });

    it("should reject device with missing name", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const registeredDevices: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registeredDevices.push(device);
      };

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "dev-1",
              name: "",
              deviceType: "on_off_light",
              clusters: [],
            });
          },
        }),
      );

      await pm.startAll();
      expect(registeredDevices).toHaveLength(0);
    });
  });

  describe("state updates", () => {
    it("should forward device state updates via callback", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const updates: Array<{
        pluginName: string;
        deviceId: string;
        clusterId: string;
        attributes: Record<string, unknown>;
      }> = [];

      pm.onDeviceRegistered = async () => {};
      pm.onDeviceStateUpdated = (pluginName, deviceId, clusterId, attrs) => {
        updates.push({ pluginName, deviceId, clusterId, attributes: attrs });
      };

      let savedCtx: PluginContext | undefined;
      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            savedCtx = ctx;
            await ctx.registerDevice({
              id: "dev-1",
              name: "Test",
              deviceType: "temperature_sensor",
              clusters: [
                {
                  clusterId: "temperatureMeasurement",
                  attributes: { measuredValue: 2000 },
                },
              ],
            });
          },
        }),
      );

      await pm.startAll();
      savedCtx!.updateDeviceState("dev-1", "temperatureMeasurement", {
        measuredValue: 2500,
      });

      expect(updates).toHaveLength(1);
      expect(updates[0].attributes).toEqual({ measuredValue: 2500 });
    });
  });

  describe("config", () => {
    it("should return config schema from plugin", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      await pm.registerBuiltIn(
        createMockPlugin({
          getConfigSchema: () => ({
            title: "Test Config",
            properties: { interval: { type: "number", title: "Interval" } },
          }),
        }),
      );

      const schema = pm.getConfigSchema("test-plugin");
      expect(schema).toBeDefined();
      expect(schema?.properties).toBeDefined();
    });

    it("should call onConfigChanged when config is updated", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const onConfigChanged = vi.fn(async () => {});
      await pm.registerBuiltIn(createMockPlugin({ onConfigChanged }));
      await pm.startAll();

      const ok = await pm.updateConfig("test-plugin", { interval: 5000 });
      expect(ok).toBe(true);
      expect(onConfigChanged).toHaveBeenCalledWith({ interval: 5000 });
    });
  });

  describe("enable/disable/reset", () => {
    it("should disable and re-enable a plugin", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      await pm.registerBuiltIn(createMockPlugin());

      await pm.disablePlugin("test-plugin");
      expect(pm.getMetadata()[0].enabled).toBe(false);

      await pm.enablePlugin("test-plugin");
      expect(pm.getMetadata()[0].enabled).toBe(true);
    });
  });

  describe("enabled persistence (#439)", () => {
    function makeDevicePlugin() {
      const onStart = vi.fn(async (ctx: PluginContext) => {
        await ctx.registerDevice({
          id: "dev-1",
          name: "Device",
          deviceType: "on_off_light",
          clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        });
      });
      return {
        plugin: createMockPlugin({ name: "persist-plugin", onStart }),
        onStart,
      };
    }

    it("keeps a disabled plugin disabled for the next manager on the same storage", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-disable-"));
      try {
        const first = makeDevicePlugin();
        const pm1 = new PluginManager("bridge-p", dir);
        await pm1.registerBuiltIn(first.plugin);
        await pm1.startAll();
        expect(pm1.getDevices("persist-plugin")).toHaveLength(1);
        await pm1.disablePlugin("persist-plugin");

        // The restart: a new manager over the same storage dir.
        const second = makeDevicePlugin();
        const pm2 = new PluginManager("bridge-p", dir);
        await pm2.registerBuiltIn(second.plugin);
        await pm2.startAll();
        expect(pm2.getMetadata()[0].enabled).toBe(false);
        expect(second.onStart).not.toHaveBeenCalled();
        expect(pm2.getDevices("persist-plugin")).toHaveLength(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("persists a re-enable the same way", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-enable-"));
      try {
        const first = makeDevicePlugin();
        const pm1 = new PluginManager("bridge-p", dir);
        await pm1.registerBuiltIn(first.plugin);
        await pm1.startAll();
        await pm1.disablePlugin("persist-plugin");
        await pm1.enablePlugin("persist-plugin");

        const second = makeDevicePlugin();
        const pm2 = new PluginManager("bridge-p", dir);
        await pm2.registerBuiltIn(second.plugin);
        await pm2.startAll();
        expect(pm2.getMetadata()[0].enabled).toBe(true);
        expect(pm2.getDevices("persist-plugin")).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("unregisters the devices on disable and registers them again on enable", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-toggle-"));
      try {
        const { plugin } = makeDevicePlugin();
        const pm = new PluginManager("bridge-p", dir);
        const unregistered: string[] = [];
        pm.onDeviceUnregistered = async (_name, deviceId) => {
          unregistered.push(deviceId);
        };
        await pm.registerBuiltIn(plugin);
        await pm.startAll();
        expect(pm.getDevices("persist-plugin")).toHaveLength(1);

        await pm.disablePlugin("persist-plugin");
        expect(unregistered).toEqual(["dev-1"]);
        expect(pm.getDevices("persist-plugin")).toHaveLength(0);

        await pm.enablePlugin("persist-plugin");
        expect(pm.getDevices("persist-plugin")).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("holds a config save while disabled and applies it on enable", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-pending-"));
      try {
        const onConfigChanged = vi.fn(async () => {});
        const { onStart } = makeDevicePlugin();
        const plugin = createMockPlugin({
          name: "persist-plugin",
          onStart,
          onConfigChanged,
        });
        const pm = new PluginManager("bridge-p", dir);
        await pm.registerBuiltIn(plugin);
        await pm.startAll();
        await pm.disablePlugin("persist-plugin");

        await pm.updateConfig("persist-plugin", { interval: 7 });
        // A save on a disabled plugin must not reach it and remount devices.
        expect(onConfigChanged).not.toHaveBeenCalled();
        expect(pm.getDevices("persist-plugin")).toHaveLength(0);

        await pm.enablePlugin("persist-plugin");
        // The parked save lands in storage before the start, so onStart
        // reads it as the persisted config; no separate callback fires.
        expect(onConfigChanged).not.toHaveBeenCalled();
        const file = path.join(dir, "plugin-bridge-p-persist-plugin.json");
        expect(JSON.parse(fs.readFileSync(file, "utf-8")).config).toEqual({
          interval: 7,
        });
        expect(pm.getMetadata()[0].config).toEqual({ interval: 7 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("disable with the breaker open (#439 review)", () => {
    function breakerPlugin() {
      const onShutdown = vi.fn(async () => {});
      const onConfigChanged = vi.fn(async () => {
        throw new Error("boom");
      });
      return {
        plugin: createMockPlugin({ onShutdown, onConfigChanged }),
        onShutdown,
      };
    }

    async function openBreaker(pm: PluginManager) {
      for (let i = 0; i < 3; i++) {
        await pm.updateConfig("test-plugin", { attempt: i });
      }
      expect(pm.getCircuitBreakerStates().get("test-plugin")?.disabled).toBe(
        true,
      );
    }

    it("still runs onShutdown on disablePlugin", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-breaker-"));
      try {
        const { plugin, onShutdown } = breakerPlugin();
        const pm = new PluginManager("bridge-b", dir);
        await pm.registerBuiltIn(plugin);
        await pm.startAll();
        await openBreaker(pm);

        await pm.disablePlugin("test-plugin");
        expect(onShutdown).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still runs onShutdown on shutdownAll", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-breaker2-"));
      try {
        const { plugin, onShutdown } = breakerPlugin();
        const pm = new PluginManager("bridge-b", dir);
        await pm.registerBuiltIn(plugin);
        await pm.startAll();
        await openBreaker(pm);

        await pm.shutdownAll("stop");
        expect(onShutdown).toHaveBeenCalledWith("stop");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("transition serialization (#439 review)", () => {
    const lightDevice = (id: string) => ({
      id,
      name: "Device",
      deviceType: "on_off_light",
      clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
    });

    it("a disable during a hung start leaves no devices mounted", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-serial-"));
      try {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const pm = new PluginManager("bridge-q", dir);
        await pm.registerBuiltIn(
          createMockPlugin({
            onStart: async (ctx: PluginContext) => {
              await gate;
              await ctx.registerDevice(lightDevice("late-1"));
            },
          }),
        );

        const start = pm.startAll();
        const disable = pm.disablePlugin("test-plugin");
        // Give the disable room to run ahead of the hung start.
        await new Promise((r) => setTimeout(r, 20));
        release();
        await Promise.all([start, disable]);

        expect(pm.getDevices("test-plugin")).toHaveLength(0);
        expect(pm.getMetadata()[0].enabled).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops a device registration arriving after a disable", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-gate-"));
      try {
        let saved!: PluginContext;
        const registered: string[] = [];
        const pm = new PluginManager("bridge-q", dir);
        pm.onDeviceRegistered = async (_n, d) => {
          registered.push(d.id);
        };
        await pm.registerBuiltIn(
          createMockPlugin({
            onStart: async (ctx: PluginContext) => {
              saved = ctx;
            },
          }),
        );
        await pm.startAll();
        await pm.disablePlugin("test-plugin");

        // A late async callback inside the plugin fires after the disable.
        await saved.registerDevice(lightDevice("zombie-1"));

        expect(pm.getDevices("test-plugin")).toHaveLength(0);
        expect(registered).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("drops a registration from a superseded start after re-enable", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-epoch-"));
      try {
        const ctxs: PluginContext[] = [];
        const pm = new PluginManager("bridge-q", dir);
        await pm.registerBuiltIn(
          createMockPlugin({
            onStart: async (ctx: PluginContext) => {
              ctxs.push(ctx);
            },
          }),
        );
        await pm.startAll();
        await pm.disablePlugin("test-plugin");
        await pm.enablePlugin("test-plugin");
        expect(ctxs).toHaveLength(2);

        await ctxs[0].registerDevice(lightDevice("stale-1"));
        expect(pm.getDevices("test-plugin")).toHaveLength(0);

        await ctxs[1].registerDevice(lightDevice("fresh-1"));
        expect(pm.getDevices("test-plugin").map((d) => d.id)).toEqual([
          "fresh-1",
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("parked config on enable (#439 review)", () => {
    it("persists the parked config before onStart so the start reads it", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-parked-"));
      try {
        const seen: unknown[] = [];
        const pm = new PluginManager("bridge-p", dir);
        await pm.registerBuiltIn(
          createMockPlugin({
            name: "persist-plugin",
            onStart: async (ctx: PluginContext) => {
              seen.push(await ctx.storage.get("config"));
            },
            onConfigChanged: async () => {},
          }),
        );
        await pm.startAll();
        await pm.disablePlugin("persist-plugin");
        await pm.updateConfig("persist-plugin", { interval: 9 });
        await pm.enablePlugin("persist-plugin");

        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual({ interval: 9 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps the parked config durable when the enable start fails", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-durable-"));
      try {
        const pm = new PluginManager("bridge-p", dir);
        await pm.registerBuiltIn(
          createMockPlugin({
            name: "persist-plugin",
            onStart: async () => {
              throw new Error("start crash");
            },
            onConfigChanged: async () => {},
          }),
        );
        await pm.startAll();
        await pm.disablePlugin("persist-plugin");
        await pm.updateConfig("persist-plugin", { mode: "x" });
        await pm.enablePlugin("persist-plugin");

        const file = path.join(dir, "plugin-bridge-p-persist-plugin.json");
        expect(JSON.parse(fs.readFileSync(file, "utf-8")).config).toEqual({
          mode: "x",
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("plugin-owned __enabled key (#439 review)", () => {
    it("leaves a plugin's own __enabled value untouched across toggles", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-own-"));
      try {
        const file = path.join(dir, "plugin-bridge-p-persist-plugin.json");
        fs.writeFileSync(file, JSON.stringify({ __enabled: "plugin-owned" }));
        const pm = new PluginManager("bridge-p", dir);
        await pm.registerBuiltIn(createMockPlugin({ name: "persist-plugin" }));
        await pm.startAll();
        // A non-boolean value is plugin data, not the manager's flag.
        expect(pm.getMetadata()[0].enabled).toBe(true);

        await pm.disablePlugin("persist-plugin");
        await pm.enablePlugin("persist-plugin");
        expect(JSON.parse(fs.readFileSync(file, "utf-8")).__enabled).toBe(
          "plugin-owned",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("migrates a legacy boolean __enabled into the manager state file", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-migrate-"));
      try {
        const file = path.join(dir, "plugin-bridge-p-persist-plugin.json");
        fs.writeFileSync(file, JSON.stringify({ __enabled: false, own: 1 }));
        const pm1 = new PluginManager("bridge-p", dir);
        await pm1.registerBuiltIn(createMockPlugin({ name: "persist-plugin" }));
        expect(pm1.getMetadata()[0].enabled).toBe(false);

        // The key goes back to the plugin, the choice moves to the manager.
        const migrated = JSON.parse(fs.readFileSync(file, "utf-8"));
        expect(migrated.__enabled).toBeUndefined();
        expect(migrated.own).toBe(1);

        const onStart = vi.fn(async () => {});
        const pm2 = new PluginManager("bridge-p", dir);
        await pm2.registerBuiltIn(
          createMockPlugin({ name: "persist-plugin", onStart }),
        );
        await pm2.startAll();
        expect(pm2.getMetadata()[0].enabled).toBe(false);
        expect(onStart).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("enable/disable results (#439 review)", () => {
    it("returns the resulting metadata and undefined for unknown names", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-result-"));
      try {
        const pm = new PluginManager("bridge-1", dir);
        await pm.registerBuiltIn(createMockPlugin());

        const off = await pm.disablePlugin("test-plugin");
        expect(off?.enabled).toBe(false);
        const on = await pm.enablePlugin("test-plugin");
        expect(on?.enabled).toBe(true);

        expect(await pm.disablePlugin("missing")).toBeUndefined();
        expect(await pm.enablePlugin("missing")).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("should export PLUGIN_API_VERSION", () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  describe("loadExternal", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const dir of tempDirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
      tempDirs.length = 0;
    });

    function createTempPlugin(code: string, name = "temp-plugin"): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-plugin-"));
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name,
          version: "0.1.0",
          main: "index.js",
          type: "module",
        }),
      );
      fs.writeFileSync(path.join(dir, "index.js"), code);
      return dir;
    }

    it("should load and start an external JS plugin", async () => {
      const pluginDir = createTempPlugin(`
export default class TestPlugin {
  name = "temp-plugin";
  version = "0.1.0";
  async onStart(ctx) {
    await ctx.registerDevice({
      id: "ext-dev-1",
      name: "External Device",
      deviceType: "on_off_light",
      clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
    });
  }
}
`);

      const pm = new PluginManager("bridge-1", storageDir);
      const registered: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_name, device) => {
        registered.push(device);
      };

      await pm.loadExternal(pluginDir, {});
      await pm.startAll();

      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe("ext-dev-1");
      expect(pm.getMetadata()[0].source).toBe(pluginDir);
    });

    it("should load the manifest main entry instead of importing the package directory", async () => {
      const pluginDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "hamh-test-plugin-main-"),
      );
      tempDirs.push(pluginDir);
      fs.mkdirSync(path.join(pluginDir, "dist"));
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "nested-main-plugin",
          version: "0.1.0",
          main: "dist/plugin.js",
          type: "module",
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "dist", "plugin.js"),
        `export default class NestedMainPlugin {
  name = "nested-main-plugin";
  version = "0.1.0";
  async onStart() {}
}`,
      );

      const pm = new PluginManager("bridge-1", storageDir);
      await pm.loadExternal(pluginDir, {});

      expect(pm.getMetadata()[0].name).toBe("nested-main-plugin");
    });

    it("should reject a manifest main entry outside the package directory", async () => {
      const pluginDir = createTempPlugin(
        "export default class X {}",
        "escaping-main-plugin",
      );
      const manifestPath = path.join(pluginDir, "package.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.main = "../outside.js";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const pm = new PluginManager("bridge-1", storageDir);
      await expect(pm.loadExternal(pluginDir, {})).rejects.toThrow(
        "must stay inside the package directory",
      );
    });

    it("should reject plugin without package.json", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-nopkg-"));
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "index.js"),
        "export default class X { name='x'; version='1'; async onStart(){} }",
      );

      const pm = new PluginManager("bridge-1", storageDir);
      await expect(pm.loadExternal(dir, {})).rejects.toThrow("no package.json");
    });

    it("should reject plugin with missing main field", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hamh-test-nomain-"));
      tempDirs.push(dir);
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "bad", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(dir, "index.js"), "export default class X {}");

      const pm = new PluginManager("bridge-1", storageDir);
      await expect(pm.loadExternal(dir, {})).rejects.toThrow('missing "main"');
    });
  });

  describe("shutdown safety", () => {
    it("should not call onShutdown on plugins that failed to start", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const onShutdown = vi.fn(async () => {});

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async () => {
            throw new Error("startup crash");
          },
          onShutdown,
        }),
      );

      await pm.startAll();
      await pm.shutdownAll("test");

      expect(onShutdown).not.toHaveBeenCalled();
    });
  });

  describe("domain mappings", () => {
    it("should register a domain mapping via context", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            ctx.registerDomainMapping({
              domain: "number",
              matterDeviceType: "dimmable_light",
            });
          },
        }),
      );

      await pm.startAll();

      const mappings = pm.getDomainMappings();
      expect(mappings.size).toBe(1);
      expect(mappings.get("number")?.matterDeviceType).toBe("dimmable_light");
    });

    it("should overwrite mapping if same domain registered twice", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          name: "plugin-a",
          onStart: async (ctx: PluginContext) => {
            ctx.registerDomainMapping({
              domain: "number",
              matterDeviceType: "dimmable_light",
            });
          },
        }),
      );
      await pm.registerBuiltIn(
        createMockPlugin({
          name: "plugin-b",
          onStart: async (ctx: PluginContext) => {
            ctx.registerDomainMapping({
              domain: "number",
              matterDeviceType: "on_off_light",
            });
          },
        }),
      );

      await pm.startAll();

      const mappings = pm.getDomainMappings();
      expect(mappings.get("number")?.matterDeviceType).toBe("on_off_light");
    });

    it("should reject invalid domain mapping", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            ctx.registerDomainMapping({
              domain: "",
              matterDeviceType: "on_off_light",
            });
            ctx.registerDomainMapping({
              domain: "number",
              matterDeviceType: "",
            });
          },
        }),
      );

      await pm.startAll();
      expect(pm.getDomainMappings().size).toBe(0);
    });

    it("should return a copy from getDomainMappings", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          onStart: async (ctx: PluginContext) => {
            ctx.registerDomainMapping({
              domain: "number",
              matterDeviceType: "dimmable_light",
            });
          },
        }),
      );

      await pm.startAll();

      const copy = pm.getDomainMappings();
      copy.delete("number");
      expect(pm.getDomainMappings().size).toBe(1);
    });
  });

  describe("failure isolation", () => {
    it("should survive plugin that throws on onStart", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          name: "bad-plugin",
          onStart: async () => {
            throw new Error("crash!");
          },
        }),
      );
      await pm.registerBuiltIn(
        createMockPlugin({
          name: "good-plugin",
          onStart: async (ctx: PluginContext) => {
            await ctx.registerDevice({
              id: "good-dev",
              name: "Good",
              deviceType: "on_off_light",
              clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
            });
          },
        }),
      );

      const registered: PluginDevice[] = [];
      pm.onDeviceRegistered = async (_n, d) => {
        registered.push(d);
      };

      await pm.startAll();

      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe("good-dev");
    });

    it("should survive plugin that throws on onConfigure", async () => {
      const pm = new PluginManager("bridge-1", storageDir);

      await pm.registerBuiltIn(
        createMockPlugin({
          name: "bad-configure",
          onConfigure: async () => {
            throw new Error("configure crash!");
          },
        }),
      );

      await pm.startAll();
      await pm.configureAll();

      const meta = pm.getMetadata();
      expect(meta).toHaveLength(1);
    });

    it("should handle multiple plugins where one fails", async () => {
      const pm = new PluginManager("bridge-1", storageDir);
      const startOrder: string[] = [];

      await pm.registerBuiltIn(
        createMockPlugin({
          name: "first",
          onStart: async () => {
            startOrder.push("first");
          },
        }),
      );
      await pm.registerBuiltIn(
        createMockPlugin({
          name: "crashing",
          onStart: async () => {
            startOrder.push("crashing");
            throw new Error("boom");
          },
        }),
      );
      await pm.registerBuiltIn(
        createMockPlugin({
          name: "third",
          onStart: async () => {
            startOrder.push("third");
          },
        }),
      );

      await pm.startAll();

      expect(startOrder).toEqual(["first", "crashing", "third"]);
    });
  });
});
