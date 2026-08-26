import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, Logger, VariableService } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { VendorId } from "@matter/main";
import {
  ContactSensorDevice,
  OnOffPlugInUnitDevice,
} from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeEndpointManager } from "../../../services/bridges/bridge-endpoint-manager.js";
import { EntityIsolationService } from "../../../services/bridges/entity-isolation-service.js";
import { PluginManager } from "../../plugin-manager.js";
import { SecurityPlugin } from "./security-plugin.js";

// Hard rule #419: a registered device must prove it mounts. The five security
// endpoints go through the real PluginManager + BridgeEndpointManager wiring
// onto a real ServerNode: real endpoint construction, real $Changed listeners,
// real pluginStateUpdating echo guard. No hand-built shortcuts.

const BRIDGE_ID = "bridge-419";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-security419-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  // PluginBasicInformationServer reads the bridge vendor info from the env.
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  EntityIsolationService.unregisterIsolationCallback(BRIDGE_ID);
  rmSync(dir, { recursive: true, force: true });
});

async function bringUp() {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `security419-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });

  const manager = new PluginManager(BRIDGE_ID, dir);
  // Only the plugin wiring runs in this test, the HA-facing deps stay inert.
  const bem = new BridgeEndpointManager(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    BRIDGE_ID,
    Logger.get("Security419"),
    manager,
  );
  await server.add(bem.root);
  // Production order (bridge.ts runStart): the node starts before the plugins
  // register, so behavior events exist when the endpoint wiring attaches.
  await server.start();

  const plugin = new SecurityPlugin({
    exitDelaySeconds: 0,
    entryDelaySeconds: 0,
    triggerTimeSeconds: 0,
    awayTriggers: "binary_sensor.door",
    triggers24h: "binary_sensor.smoke",
  });
  await manager.registerBuiltIn(plugin);
  await manager.startAll();

  const endpoints = new Map<string, Endpoint>();
  for (const part of bem.root.parts) {
    endpoints.set(part.id.replace(/^plugin_/, ""), part as Endpoint);
  }
  return { manager, bem, plugin, endpoints };
}

// biome-ignore lint/suspicious/noExplicitAny: read behavior state
const stateOf = (endpoint: Endpoint) => endpoint.state as any;

const MODE_IDS = ["mode_home", "mode_away", "mode_night", "mode_vacation"];

describe("security plugin bring-up (#419)", () => {
  it("mounts the four mode switches and the alarm contact sensor", async () => {
    const { manager, endpoints } = await bringUp();

    expect([...endpoints.keys()]).toEqual([...MODE_IDS, "alarm"]);
    for (const [id, name] of [
      ["mode_home", "Home"],
      ["mode_away", "Away"],
      ["mode_night", "Night"],
      ["mode_vacation", "Vacation"],
    ] as const) {
      expect(endpoints.get(id)!.type.deviceType).toBe(
        OnOffPlugInUnitDevice.deviceType,
      );
      expect(stateOf(endpoints.get(id)!).onOff.onOff).toBe(false);
      expect(
        stateOf(endpoints.get(id)!).bridgedDeviceBasicInformation,
      ).toMatchObject({
        nodeLabel: name,
        productName: name,
        productLabel: name,
      });
    }
    expect(endpoints.get("alarm")!.type.deviceType).toBe(
      ContactSensorDevice.deviceType,
    );
    expect(stateOf(endpoints.get("alarm")!).booleanState.stateValue).toBe(true);

    await manager.shutdownAll();
  });

  it("drives the machine through real writes without oscillating", async () => {
    const { manager, plugin, endpoints } = await bringUp();
    const counts: Record<string, number> = {};
    for (const id of MODE_IDS) {
      counts[id] = 0;
      // biome-ignore lint/suspicious/noExplicitAny: matter.js events are dynamically typed
      const events = endpoints.get(id)!.events as any;
      events.onOff.onOff$Changed.on(() => {
        counts[id]++;
      });
    }

    // A controller write on the Away switch arms the machine; the exclusivity
    // echo reports the other switches off.
    await endpoints.get("mode_away")!.set({ onOff: { onOff: true } } as never);
    await vi.waitFor(() => {
      expect(stateOf(endpoints.get("mode_away")!).onOff.onOff).toBe(true);
      for (const id of MODE_IDS.filter((i) => i !== "mode_away")) {
        expect(stateOf(endpoints.get(id)!).onOff.onOff).toBe(false);
      }
    });

    // The write reached the machine: its trigger now trips the alarm.
    plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
    await vi.waitFor(() => {
      expect(stateOf(endpoints.get("alarm")!).booleanState.stateValue).toBe(
        false,
      );
    });

    // Switching over flips Away off through the echo and clears the alarm.
    await endpoints.get("mode_home")!.set({ onOff: { onOff: true } } as never);
    await vi.waitFor(() => {
      expect(stateOf(endpoints.get("mode_home")!).onOff.onOff).toBe(true);
      expect(stateOf(endpoints.get("mode_away")!).onOff.onOff).toBe(false);
      expect(stateOf(endpoints.get("alarm")!).booleanState.stateValue).toBe(
        true,
      );
    });

    // No oscillation: the echo guard keeps internal updates from re-entering
    // the machine, so the change counts stay exactly at the driven writes.
    await new Promise((r) => setTimeout(r, 50));
    expect(counts).toEqual({
      mode_home: 1,
      mode_away: 2,
      mode_night: 0,
      mode_vacation: 0,
    });

    await manager.shutdownAll();
  });

  it("unmounts the endpoints on disable and remounts them on enable (#439)", async () => {
    const { manager, bem } = await bringUp();
    expect([...bem.root.parts].length).toBe(5);

    await bem.disablePlugin("security");
    expect([...bem.root.parts].length).toBe(0);
    expect(manager.getMetadata()[0].enabled).toBe(false);

    await bem.enablePlugin("security");
    expect([...bem.root.parts].length).toBe(5);
    expect(manager.getMetadata()[0].enabled).toBe(true);

    await manager.shutdownAll();
  });

  it("keeps the endpoint numbers across a disable and enable cycle (#439 review)", async () => {
    const { manager, bem } = await bringUp();
    const numbersOf = () => {
      const map = new Map<string, number | undefined>();
      for (const part of bem.root.parts) {
        map.set(part.id, (part as Endpoint).number);
      }
      return map;
    };
    const before = numbersOf();
    expect(before.size).toBe(5);

    await bem.disablePlugin("security");
    await bem.enablePlugin("security");

    // Controllers keep names and rooms only while the numbers hold still.
    expect(numbersOf()).toEqual(before);

    await manager.shutdownAll();
  });

  it("keeps a controller write during an internal update on another switch", async () => {
    const { manager, bem, plugin, endpoints } = await bringUp();
    // Hold Home's internal-update window open, exactly as a slow setStateOf
    // would, while the controller writes Away.
    // Let the bring-up state pushes settle so their guard cleanup cannot
    // erase the entry held below.
    await new Promise((r) => setTimeout(r, 50));
    // biome-ignore lint/suspicious/noExplicitAny: reach the private echo guard
    const guard = (bem as any).pluginStateUpdating as Set<string>;
    guard.add("mode_home");
    await endpoints.get("mode_away")!.set({ onOff: { onOff: true } } as never);

    // The Away write must reach the machine even while the Home update is in
    // flight: it armed, so its trigger trips the alarm. The guard entry stays
    // held the whole time, only a per-device guard lets this pass.
    await vi.waitFor(() => {
      plugin.handleTriggerEvent("binary_sensor.door", "on", "motion");
      expect(stateOf(endpoints.get("alarm")!).booleanState.stateValue).toBe(
        false,
      );
    });
    guard.delete("mode_home");

    await manager.shutdownAll();
  });
});
