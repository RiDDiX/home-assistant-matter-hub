import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, Logger, VariableService } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { VendorId } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import {
  AirPurifierDevice,
  HumiditySensorDevice,
  OnOffPlugInUnitDevice,
} from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeEndpointManager } from "../../../services/bridges/bridge-endpoint-manager.js";
import { EntityIsolationService } from "../../../services/bridges/entity-isolation-service.js";
import { PluginManager } from "../../plugin-manager.js";
import { pluginStorageFilePath } from "../../plugin-storage.js";
import { VeSyncPlugin } from "./vesync-plugin.js";

// #419: units go through the real PluginManager and BridgeEndpointManager onto a
// real ServerNode, writes come back through the real $Changed listeners into a
// fake VeSync cloud.

const BRIDGE_ID = "bridge-vesync";
const AUTH = "/globalPlatform/api/accountAuth/v1/authByPWDOrOTM";
const LOGIN = "/user/api/accountManage/v1/loginByAuthorizeCode4Vesync";
const DEVICES = "/cloud/v1/deviceManaged/devices";
const V2 = "/cloud/v2/deviceManaged/bypassV2";

type Json = Record<string, unknown>;

const ROWS = [
  ["fryer", "Fryer", "CAF-TF102S", "online"],
  ["air", "Purifier", "Core300S", "online"],
  ["auto", "Bedroom", "Core400S", "online"],
  ["hum", "Humidifier", "Classic300S", "online"],
  ["plug", "Plug", "WHOGPLUG", "offline"],
].map(([cid, deviceName, deviceType, connectionStatus]) => ({
  cid,
  deviceName,
  deviceType,
  configModule: `module-${cid}`,
  connectionStatus,
}));

const STATUS: Record<string, Json> = {
  fryer: {
    statusList: [
      { cookStatus: "cooking", chamber: 1 },
      { cookStatus: "standby", chamber: 2 },
    ],
    syncType: 0,
    workChamber: 1,
  },
  air: { enabled: true, level: 2, mode: "manual" },
  auto: { enabled: true, level: 4, mode: "auto" },
  hum: { enabled: true, humidity: 45 },
};

function fakeCloud() {
  const calls: { path: string; body: Json }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Json;
    calls.push({ path, body });
    const ok = (result: unknown) => Response.json({ code: 0, result });
    if (path === AUTH) return ok({ accountID: "1", authorizeCode: "code" });
    if (path === LOGIN) {
      return ok({ token: "tok", accountID: "1", countryCode: "US" });
    }
    if (path === DEVICES) return ok({ total: ROWS.length, list: ROWS });
    const status = STATUS[String(body.cid)];
    if (path !== V2 || !status) return Response.json({ code: -11300000 });
    const method = (body.payload as Json).method as string;
    return ok({ code: 0, result: method.startsWith("get") ? status : {} });
  };
  const v2 = () =>
    calls
      .filter((c) => c.path === V2)
      .map((c): Json => ({ cid: c.body.cid, ...(c.body.payload as Json) }));
  return { fetch, calls, v2 };
}

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-vesync-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
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
  // Cached list and expose switches as a previous run left them: the units
  // mount inside the start batch, the cloud fills in their state afterwards.
  writeFileSync(
    pluginStorageFilePath(dir, BRIDGE_ID, "vesync"),
    JSON.stringify({
      config: {
        email: "someone@example.com",
        password: "pw",
        ...Object.fromEntries(ROWS.map((r) => [`expose_${r.cid}`, true])),
      },
      terminalId: "2abcdef0123456789abcdef0123456789",
      account: createHash("sha256")
        .update("someone@example.com\0pw")
        .digest("hex"),
      devices: ROWS.map((r) => ({
        cid: r.cid,
        name: r.deviceName,
        deviceType: r.deviceType,
        configModule: r.configModule,
        online: true,
      })),
    }),
  );
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `vesync-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const manager = new PluginManager(BRIDGE_ID, dir);
  const bem = new BridgeEndpointManager(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    BRIDGE_ID,
    Logger.get("VeSyncBringUp"),
    manager,
  );
  await server.add(bem.root);
  bem.setTopologyChangeHandler(async (change) => {
    await server!.act("plugin topology change", (agent) =>
      agent.get(BasicInformationServer).increaseConfigurationVersion(change),
    );
  });
  await server.start();

  const cloud = fakeCloud();
  await manager.registerBuiltIn(new VeSyncPlugin({ fetch: cloud.fetch }));
  await manager.startAll();

  const endpoints = new Map<string, Endpoint>();
  for (const part of bem.root.parts) {
    endpoints.set(part.id.replace(/^plugin_vesync_/, ""), part as Endpoint);
  }
  const writes: unknown[][] = [];
  for (const device of manager.getDevices("vesync")) {
    const original = device.onAttributeWrite!.bind(device);
    device.onAttributeWrite = (...args) => {
      writes.push([device.id, ...args]);
      return original(...args);
    };
  }
  const get = (id: string) => {
    const endpoint = endpoints.get(id);
    if (!endpoint) throw new Error(`no endpoint ${id}`);
    return endpoint;
  };
  // the first poll ends with the purifier state
  await vi.waitFor(() =>
    expect(stateOf(get("air")).fanControl.percentSetting).toBe(66),
  );
  return { manager, endpoints, get, cloud, writes };
}

// biome-ignore lint/suspicious/noExplicitAny: read behavior state
const stateOf = (endpoint: Endpoint) => endpoint.state as any;

describe("vesync plugin bring-up (#419)", () => {
  it("mounts every unit and shows the polled state", async () => {
    const { manager, endpoints, get } = await bringUp();

    expect([...endpoints.keys()]).toEqual([
      "fryer_left",
      "fryer_right",
      "air",
      "auto",
      "hum",
      "hum_humidity",
      "plug",
    ]);
    for (const id of ["fryer_left", "fryer_right", "hum", "plug"]) {
      expect(get(id).type.deviceType).toBe(OnOffPlugInUnitDevice.deviceType);
    }
    expect(get("air").type.deviceType).toBe(AirPurifierDevice.deviceType);
    expect(get("hum_humidity").type.deviceType).toBe(
      HumiditySensorDevice.deviceType,
    );
    expect(
      stateOf(get("fryer_left")).bridgedDeviceBasicInformation,
    ).toMatchObject({ nodeLabel: "Fryer Left", reachable: true });

    await vi.waitFor(() => {
      expect(stateOf(get("fryer_left")).onOff.onOff).toBe(true);
      expect(stateOf(get("hum")).onOff.onOff).toBe(true);
      expect(
        stateOf(get("hum_humidity")).relativeHumidityMeasurement.measuredValue,
      ).toBe(4500);
    });
    expect(stateOf(get("fryer_right")).onOff.onOff).toBe(false);
    expect(stateOf(get("air")).fanControl).toMatchObject({
      fanMode: 2,
      percentSetting: 66,
      percentCurrent: 66,
    });
    // the endpoint has no Auto feature, auto mode shows the running third
    expect(stateOf(get("auto")).fanControl).toMatchObject({
      fanModeSequence: 0,
      fanMode: 3,
      percentSetting: 100,
      percentCurrent: 100,
    });
    // offline in the device list
    expect(stateOf(get("plug")).bridgedDeviceBasicInformation.reachable).toBe(
      false,
    );

    await manager.shutdownAll();
  });

  it("sends an OnOff off command on a basket as endCook", async () => {
    const { manager, get, cloud, writes } = await bringUp();
    await vi.waitFor(() =>
      expect(stateOf(get("fryer_left")).onOff.onOff).toBe(true),
    );
    writes.length = 0;
    const before = cloud.v2().length;

    // biome-ignore lint/suspicious/noExplicitAny: matter.js agent is dynamic
    await get("fryer_left").act((agent) => (agent as any).onOff.off());

    await vi.waitFor(() =>
      expect(cloud.v2().slice(before)).toEqual([
        {
          cid: "fryer",
          method: "endCook",
          source: "APP",
          data: { chamber: 1 },
          subDeviceNo: 0,
          subDeviceType: "",
        },
      ]),
    );
    // one command, one committed attribute, one call
    expect(writes).toEqual([["vesync_fryer_left", "onOff", "onOff", false]]);

    await manager.shutdownAll();
  });

  it("snaps an OnOff on command on a basket back without a command", async () => {
    const { manager, get, cloud } = await bringUp();
    const before = cloud.v2().length;

    // biome-ignore lint/suspicious/noExplicitAny: matter.js agent is dynamic
    await get("fryer_right").act((agent) => (agent as any).onOff.on());
    expect(stateOf(get("fryer_right")).onOff.onOff).toBe(true);

    await vi.waitFor(() =>
      expect(stateOf(get("fryer_right")).onOff.onOff).toBe(false),
    );
    expect(
      cloud
        .v2()
        .slice(before)
        .filter((c) => !String(c.method).startsWith("get")),
    ).toEqual([]);

    await manager.shutdownAll();
  });

  it("sends a percentSetting write on the purifier as setLevel", async () => {
    const { manager, get, cloud, writes } = await bringUp();
    writes.length = 0;
    const before = cloud.v2().length;

    await get("air").set({ fanControl: { percentSetting: 100 } } as never);

    await vi.waitFor(() =>
      expect(cloud.v2().slice(before)).toEqual([
        {
          cid: "air",
          method: "setLevel",
          source: "APP",
          data: { id: 0, level: 3, type: "wind" },
        },
      ]),
    );
    await get("air").set({ fanControl: { fanMode: 0 } } as never);
    await vi.waitFor(() =>
      expect(cloud.v2().at(-1)).toMatchObject({
        method: "setSwitch",
        data: { enabled: false, id: 0 },
      }),
    );
    // the stock FanControlServer couples nothing: one write, one call
    expect(writes).toEqual([
      ["vesync_air", "fanControl", "percentSetting", 100],
      ["vesync_air", "fanControl", "fanMode", 0],
    ]);

    await manager.shutdownAll();
  });
});
