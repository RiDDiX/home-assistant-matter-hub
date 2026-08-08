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

      pm.disablePlugin("test-plugin");
      expect(pm.getMetadata()[0].enabled).toBe(false);

      pm.enablePlugin("test-plugin");
      expect(pm.getMetadata()[0].enabled).toBe(true);
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
