import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClimateDeviceFeature,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Bytes, Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { Endpoint, ServerNode } from "@matter/main/node";
import { Invoke, Read, Write } from "@matter/main/protocol";
import {
  DeviceTypeId,
  TlvAny,
  TlvBoolean,
  TlvByteString,
  TlvField,
  TlvObject,
  TlvUInt16,
  TlvUInt32,
} from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import type {
  HomeAssistantRegistry,
  HomeAssistantStates,
} from "../../../../services/home-assistant/home-assistant-registry.js";
import { AppleThermostatServerBase } from "../../../behaviors/apple-adaptive-temperature.js";
import { createPresetHandle } from "../../../behaviors/thermostat-server.js";
import { ServerModeServerNode } from "../../server-mode-server-node.js";
import { asStandaloneEndpointType } from "../../standalone-endpoint-type.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";
import { ClimateDevice } from "./index.js";

const DEVICE_ID = "ecobee-remote-1";
const CLIMATE_ID = "climate.ecobee_remote";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let controller: ServerNode | undefined;
let calls: HomeAssistantAction[] = [];

interface ThermostatClusterState {
  attributeList: number[];
  acceptedCommandList: number[];
  presetTypes: unknown[];
  numberOfPresets: number;
  activePresetHandle: Bytes | null;
  persistedPresets: Thermostat.Preset[];
  systemMode?: number;
  occupiedHeatingSetpoint?: number;
  occupiedCoolingSetpoint?: number;
  appleAttr0002?: boolean;
  appleAttr0009?: Uint8Array | null;
  appleAttr000B?: number | null;
  appleAttr000C?: number | null;
  appleAttr000E?: boolean;
  appleAttr0010?: unknown[];
  appleAttr0011?: { f0: boolean; f1?: number | null };
  temperatureSetpointHold?: number;
  temperatureSetpointHoldDuration?: number | null;
  setpointHoldExpiryTimestamp?: number | null;
}

function getThermostatState(endpoint: LegacyEndpoint): ThermostatClusterState {
  return (
    endpoint.state as unknown as {
      thermostat: ThermostatClusterState;
    }
  ).thermostat;
}

function makeHaState(
  overrides?: Partial<{
    state: string;
    attributes: Record<string, unknown>;
  }>,
): HomeAssistantEntityState {
  return {
    entity_id: CLIMATE_ID,
    state: overrides?.state ?? "heat",
    attributes: {
      friendly_name: "Thermostat",
      hvac_modes: ["heat", "cool", "heat_cool", "off"],
      hvac_action: "idle",
      min_temp: 10,
      max_temp: 30,
      temperature: 20,
      current_temperature: 19.5,
      supported_features: 3, // TARGET_TEMPERATURE | TARGET_TEMPERATURE_RANGE
      ...overrides?.attributes,
    },
    context: { id: `ctx-${counter++}` },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  } as unknown as HomeAssistantEntityState;
}

function createBridgeRegistry(
  dataProvider: BridgeDataProvider,
  haState: HomeAssistantEntityState,
): BridgeRegistry {
  const fullEntities: Record<string, HomeAssistantEntityRegistry> = {
    [CLIMATE_ID]: {
      area_id: undefined,
      categories: {},
      device_id: DEVICE_ID,
      disabled_by: null,
      entity_category: null,
      entity_id: CLIMATE_ID,
      has_entity_name: false,
      hidden_by: null,
      id: CLIMATE_ID,
      labels: [],
      options: undefined,
      original_name: "Thermostat",
      platform: "homekit_controller",
      translation_key: null,
      unique_id: CLIMATE_ID,
    },
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE_ID]: { id: DEVICE_ID, name: "Ecobee" } },
    entities: fullEntities,
    states: { [CLIMATE_ID]: haState },
  } as unknown as HomeAssistantRegistry;

  return new BridgeRegistry(haRegistry, dataProvider);
}

function initEnv() {
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    fireEvent() {},
  } as unknown as HomeAssistantActions);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
  } as unknown as EntityStateProvider);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
  } as unknown as HomeAssistantConfig);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-adaptive-remote-"));
  calls = [];
  initEnv();
});

afterEach(async () => {
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mountStandalone(
  appleAdaptiveTemperature: boolean,
  nodeId = `adaptive-node-${counter++}`,
) {
  const bridgeData = {
    id: nodeId,
    name: "Test Thermostat",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: {
      serverMode: true,
      appleAdaptiveTemperature,
    },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "test",
      productId: 0x8000,
      productName: "test",
      productLabel: "test",
      hardwareVersion: 1,
      softwareVersion: 1,
    },
  } as ConstructorParameters<typeof BridgeDataProvider>[0];

  const dataProvider = new BridgeDataProvider(bridgeData);
  env.set(BridgeDataProvider, dataProvider);

  const reg = createBridgeRegistry(dataProvider, makeHaState());

  const endpoint = await LegacyEndpoint.create(
    reg,
    CLIMATE_ID,
    undefined,
    undefined,
    true,
  );
  expect(endpoint).toBeDefined();

  const serverNode = new ServerModeServerNode(env, {
    ...bridgeData,
    id: nodeId,
  } as ConstructorParameters<typeof ServerModeServerNode>[1]);
  server = serverNode;
  await serverNode.construction;
  await serverNode.addDevice(endpoint!);
  await serverNode.updateAdvertisedDeviceType(
    DeviceTypeId(endpoint!.type.deviceType),
  );
  await serverNode.start();

  return { endpoint: endpoint!, serverNode };
}

async function mountStandaloneAndCommission(appleAdaptiveTemperature: boolean) {
  const { endpoint, serverNode } = await mountStandalone(
    appleAdaptiveTemperature,
  );

  const port = (
    serverNode.state as unknown as { network: { operationalPort: number } }
  ).network.operationalPort;

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      environment: env,
      id: `adaptive-controller-${counter++}`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await controller.start();

  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: `remote-${counter}`,
    D: (
      serverNode.state as unknown as {
        commissioning: { discriminator: number };
      }
    ).commissioning.discriminator,
    CM: 1,
  } as unknown as Parameters<typeof controller.peers.forDescriptor>[0]);

  await client.commission({
    passcode: (
      serverNode.state as unknown as { commissioning: { passcode: number } }
    ).commissioning.passcode,
    discriminator: (
      serverNode.state as unknown as {
        commissioning: { discriminator: number };
      }
    ).commissioning.discriminator,
    autoSubscribe: false,
    autoStateInitialize: false,
  });

  return {
    endpoint: endpoint!,
    client: client as unknown as {
      interaction: {
        invoke(
          request: unknown,
        ): AsyncIterable<{ kind: string; status?: number; data?: unknown }[]>;
        read(
          request: unknown,
        ): AsyncIterable<{ kind: string; value?: unknown }[]>;
        write(request: unknown): Promise<{ status?: number }[]>;
      };
    },
  };
}

const AppleThermostatCluster = AppleThermostatServerBase.cluster;

async function remoteInvoke(
  client: Awaited<ReturnType<typeof mountStandaloneAndCommission>>["client"],
  endpointNo: number,
  cluster: unknown,
  command: string,
  fields: unknown,
) {
  const response = client.interaction.invoke(
    Invoke({
      commands: [{ endpoint: endpointNo, cluster, command, fields }],
    } as unknown as Parameters<typeof Invoke>[0]),
  );
  for await (const chunk of response) {
    for (const entry of chunk) {
      if (entry.kind === "cmd-status" && entry.status !== 0) {
        throw new Error(`${command} failed with status ${entry.status}`);
      }
      if (
        entry.kind === "cmd-response" &&
        (entry.data as { statusCode?: number } | undefined)?.statusCode !==
          undefined &&
        (entry.data as { statusCode?: number }).statusCode !== 0
      ) {
        throw new Error(
          `${command} response failed: ${JSON.stringify(entry.data)}`,
        );
      }
    }
  }
}

async function remoteWriteAttr(
  client: Awaited<ReturnType<typeof mountStandaloneAndCommission>>["client"],
  endpointNo: number,
  cluster: unknown,
  attributes: string,
  value: unknown,
) {
  const result = await client.interaction.write(
    Write(
      Write.Attribute({
        endpoint: endpointNo,
        cluster,
        attributes,
        value,
      } as unknown as Parameters<typeof Write.Attribute>[0]),
    ),
  );
  expect(result[0]?.status).toBe(0);
}

async function remoteWriteAttrs(
  client: Awaited<ReturnType<typeof mountStandaloneAndCommission>>["client"],
  endpointNo: number,
  entries: Array<{ cluster: unknown; attributes: string; value: unknown }>,
) {
  const result = await client.interaction.write(
    Write(
      ...entries.map((entry) =>
        Write.Attribute({
          endpoint: endpointNo,
          cluster: entry.cluster,
          attributes: entry.attributes,
          value: entry.value,
        } as unknown as Parameters<typeof Write.Attribute>[0]),
      ),
    ),
  );
  for (const r of result) {
    expect(r.status).toBe(0);
  }
}

async function remoteReadAttr(
  client: Awaited<ReturnType<typeof mountStandaloneAndCommission>>["client"],
  endpointNo: number,
  cluster: unknown,
  attributes: string,
): Promise<unknown> {
  for await (const chunk of client.interaction.read(
    Read(
      Read.Attribute({
        endpoint: endpointNo,
        cluster,
        attributes,
      } as unknown as Parameters<typeof Read.Attribute>[0]),
    ),
  )) {
    for (const r of chunk) {
      if (r.kind === "attr-value") {
        return r.value;
      }
    }
  }
  return undefined;
}

async function pushHaUpdate(
  endpoint: LegacyEndpoint,
  overrides: Parameters<typeof makeHaState>[0],
  waitUntil: () => void,
) {
  const states: HomeAssistantStates = { [CLIMATE_ID]: makeHaState(overrides) };
  await endpoint.updateStates(states);
  await vi.waitFor(waitUntil, { timeout: 2000, interval: 15 });
}

describe(
  "Apple Adaptive Temperature over Matter Fabric",
  { timeout: 30_000 },
  () => {
    it("handles Apple 0x1349 MEI commissioning sequence and HA updateStates lifecycle end-to-end", async () => {
      const { endpoint, client } = await mountStandaloneAndCommission(true);
      const t = getThermostatState(endpoint);
      expect(t.attributeList).toContain(0x13490002);
      expect(t.acceptedCommandList).toContain(0x134900f3);
      expect(t.acceptedCommandList).toContain(0x134900f4);
      expect(t.acceptedCommandList).toContain(0x134900f7);

      const occupiedHandle = createPresetHandle(
        Thermostat.PresetScenario.Occupied,
      );

      // 1. Apple Home enable sequence over fabric: 0002 -> F7 -> AtomicRequest([0x13490010]) -> 0011
      const emptyTlvStruct = TlvAny.decode(TlvObject({}).encode({}));
      await remoteWriteAttr(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleAttr0002",
        true,
      );
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF7",
        emptyTlvStruct,
      );
      await remoteInvoke(client, endpoint.number, Thermostat, "atomicRequest", {
        requestType: Thermostat.RequestType.BeginWrite,
        attributeRequests: [0x13490010],
        timeout: 3000,
      });
      await remoteWriteAttr(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleAttr0010",
        [{ presetHandle: occupiedHandle, f1: 1, f2: true }],
      );
      await remoteInvoke(client, endpoint.number, Thermostat, "atomicRequest", {
        requestType: Thermostat.RequestType.CommitWrite,
        attributeRequests: [0x13490010],
      });
      await remoteWriteAttr(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleAttr0011",
        { f0: true },
      );

      expect(t.appleAttr0010).toHaveLength(1);
      expect(t.appleAttr0011).toEqual({ f0: true });

      // 2. Activate Occupied preset via appleCmdF3 over fabric
      const f3Payload = TlvObject({
        handle: TlvField(0, TlvByteString),
        duration: TlvField(1, TlvUInt32),
        flag: TlvField(2, TlvBoolean),
      }).encode({
        handle: occupiedHandle,
        duration: 86400,
        flag: false,
      });
      calls = [];
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF3",
        TlvAny.decode(f3Payload),
      );

      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, occupiedHandle),
      ).toBe(true);
      expect(
        t.appleAttr0009 != null &&
          Bytes.areEqual(t.appleAttr0009, occupiedHandle),
      ).toBe(true);
      expect(t.appleAttr000B).not.toBeNull();
      expect(calls).toEqual([
        { action: "climate.set_temperature", data: { temperature: 20 } },
      ]);

      // Remote read of appleAttr000B (TlvEpochS on the wire encodes Matter epoch seconds: unix - 946_684_800)
      const wireExpiry = await remoteReadAttr(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleAttr000B",
      );
      const expectedMatterExpiry =
        Math.floor(Date.now() / 1000) - 946_684_800 + 86_400;
      expect(typeof wireExpiry).toBe("number");
      expect(wireExpiry).toBeGreaterThanOrEqual(expectedMatterExpiry - 30);
      expect(wireExpiry).toBeLessThanOrEqual(expectedMatterExpiry + 30);

      // 3. Edit preset via AtomicRequest([0x0050])
      calls = [];
      await remoteInvoke(client, endpoint.number, Thermostat, "atomicRequest", {
        requestType: Thermostat.RequestType.BeginWrite,
        attributeRequests: [80],
        timeout: 3000,
      });
      const updatedPresets = t.persistedPresets.map((p) =>
        p.presetHandle !== null &&
        Bytes.areEqual(p.presetHandle, occupiedHandle)
          ? { ...p, heatingSetpoint: 2150, coolingSetpoint: 2333 }
          : p,
      );
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "presets",
        updatedPresets,
      );
      await remoteInvoke(client, endpoint.number, Thermostat, "atomicRequest", {
        requestType: Thermostat.RequestType.CommitWrite,
        attributeRequests: [80],
      });
      expect(t.occupiedHeatingSetpoint).toBe(2150);
      expect(calls).toEqual([
        { action: "climate.set_temperature", data: { temperature: 21.5 } },
      ]);

      // 4. Delayed HA echo within 8s window preserves activePresetHandle across preCommit
      calls = [];
      await pushHaUpdate(
        endpoint,
        {
          state: "heat",
          attributes: { temperature: 25 },
        },
        () => {
          expect(t.occupiedHeatingSetpoint).toBe(2500);
        },
      );
      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, occupiedHandle),
      ).toBe(true);

      // 5. Rounding drift within ±0.6°C preserves activePresetHandle across preCommit
      await pushHaUpdate(
        endpoint,
        {
          state: "heat",
          attributes: { temperature: 21.2 },
        },
        () => {
          expect(t.occupiedHeatingSetpoint).toBe(2120);
        },
      );
      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, occupiedHandle),
      ).toBe(true);
      expect(t.appleAttr0009).not.toBeNull();
      expect(t.appleAttr000B).not.toBeNull();

      // 6. Active HVAC mode switch heat -> cool preserves preset across preCommit and applies 23.3°C
      calls = [];
      await pushHaUpdate(
        endpoint,
        {
          state: "cool",
          attributes: { temperature: 26 },
        },
        () => {
          expect(t.systemMode).toBe(Thermostat.SystemMode.Cool);
          expect(calls).toHaveLength(1);
        },
      );
      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, occupiedHandle),
      ).toBe(true);
      expect(t.appleAttr0009).not.toBeNull();
      expect(t.appleAttr000B).not.toBeNull();
      expect(calls).toEqual([
        { action: "climate.set_temperature", data: { temperature: 23.3 } },
      ]);

      // 7. Preserving preset across Off, then direct standard SetActivePresetRequest over fabric
      await pushHaUpdate(
        endpoint,
        {
          state: "off",
          attributes: { temperature: 20 },
        },
        () => {
          expect(t.systemMode).toBe(Thermostat.SystemMode.Off);
        },
      );
      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, occupiedHandle),
      ).toBe(true);

      const sleepHandle = createPresetHandle(Thermostat.PresetScenario.Sleep);
      calls = [];
      await remoteInvoke(
        client,
        endpoint.number,
        Thermostat,
        "setActivePresetRequest",
        { presetHandle: sleepHandle },
      );
      expect(
        t.activePresetHandle !== null &&
          Bytes.areEqual(t.activePresetHandle, sleepHandle),
      ).toBe(true);
      expect(
        t.appleAttr0009 != null && Bytes.areEqual(t.appleAttr0009, sleepHandle),
      ).toBe(true);
      expect(t.appleAttr000B).toBeNull();
      expect(calls).toEqual([
        { action: "climate.set_hvac_mode", data: { hvac_mode: "heat" } },
        {
          action: "climate.set_temperature",
          data: { hvac_mode: "heat", temperature: 18 },
        },
      ]);

      // 8. Real fabric cross-mode direct setpoint write in Heat mode enters Apple hold (keeps scheduled preset),
      // and controller writes to temperatureSetpointHoldDuration / appleAttr000E / temperatureSetpointHold work over fabric
      calls = [];
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "occupiedCoolingSetpoint",
        2600,
      );
      expect(t.activePresetHandle).toBeNull();
      expect(
        t.appleAttr0009 != null && Bytes.areEqual(t.appleAttr0009, sleepHandle),
      ).toBe(true);
      expect(t.appleAttr000B).toBeNull();
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(true);
      expect(calls).toEqual([]);

      const expectedHoldUnixExpiry = Math.floor(Date.now() / 1000) + 180 * 60;
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "temperatureSetpointHoldDuration",
        180,
      );
      expect(t.appleAttr000E).toBe(false);
      // Read.Attribute decodes TlvEpochS back to Unix seconds (wire value is expiry - 946_684_800)
      const holdExpiryUnix = (await remoteReadAttr(
        client,
        endpoint.number,
        Thermostat,
        "setpointHoldExpiryTimestamp",
      )) as number;
      expect(holdExpiryUnix).toBeGreaterThanOrEqual(
        expectedHoldUnixExpiry - 30,
      );
      expect(holdExpiryUnix).toBeLessThanOrEqual(expectedHoldUnixExpiry + 30);

      await remoteWriteAttr(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleAttr000E",
        true,
      );
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.appleAttr000C).toBe(2);
      expect(t.temperatureSetpointHoldDuration).toBeNull();
      expect(t.setpointHoldExpiryTimestamp).toBeNull();

      calls = [];
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "temperatureSetpointHold",
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      );
      // Synchronous clearing of hold metadata before deferred preset restoration completes
      expect(t.temperatureSetpointHoldDuration).toBeNull();
      expect(t.setpointHoldExpiryTimestamp).toBeNull();
      expect(t.appleAttr000C).toBeNull();
      expect(t.appleAttr000E).toBe(true);
      await vi.waitFor(() => {
        expect(
          t.activePresetHandle !== null &&
            Bytes.areEqual(t.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t.occupiedHeatingSetpoint).toBe(1800);
        expect(calls).toEqual([
          { action: "climate.set_temperature", data: { temperature: 18 } },
        ]);
      });

      // Real fabric appleCmdF9 hold duration transitions ("For 3 hours", "Indefinitely", "Holding until next event")
      const f9ThreeHoursPayload = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
        durationMinutes: TlvField(1, TlvUInt16),
      }).encode({ resumeOnNextEvent: false, durationMinutes: 180 });
      const expectedF9Expiry = Math.floor(Date.now() / 1000) + 180 * 60;
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF9",
        TlvAny.decode(f9ThreeHoursPayload),
      );
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBe(180);
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(false);
      const f9ExpiryRead = (await remoteReadAttr(
        client,
        endpoint.number,
        Thermostat,
        "setpointHoldExpiryTimestamp",
      )) as number;
      expect(f9ExpiryRead).toBeGreaterThanOrEqual(expectedF9Expiry - 30);
      expect(f9ExpiryRead).toBeLessThanOrEqual(expectedF9Expiry + 30);

      const f9IndefinitePayload = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
      }).encode({ resumeOnNextEvent: false });
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF9",
        TlvAny.decode(f9IndefinitePayload),
      );
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBeNull();
      expect(t.setpointHoldExpiryTimestamp).toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(false);

      const f9NextEventPayload = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
      }).encode({ resumeOnNextEvent: true });
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF9",
        TlvAny.decode(f9NextEventPayload),
      );
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBeNull();
      expect(t.setpointHoldExpiryTimestamp).toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(true);

      // Direct End Hold straight from a timed hold ("For 3 hours", duration = 180 -> null)
      // must still restore activePresetHandle without duration$Changed cancelling the restore timer.
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF9",
        TlvAny.decode(f9ThreeHoursPayload),
      );
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBe(180);
      expect(t.appleAttr000E).toBe(false);

      calls = [];
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "temperatureSetpointHold",
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      );
      await vi.waitFor(() => {
        expect(
          t.activePresetHandle !== null &&
            Bytes.areEqual(t.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t.occupiedHeatingSetpoint).toBe(1800);
        expect(t.temperatureSetpointHoldDuration).toBeNull();
        expect(t.setpointHoldExpiryTimestamp).toBeNull();
        expect(t.appleAttr000C).toBeNull();
        expect(t.appleAttr000E).toBe(true);
        expect(calls).toEqual([
          { action: "climate.set_temperature", data: { temperature: 18 } },
        ]);
      });

      // 9. Re-activate via appleCmdF3 and verify appleCmdF4 clears active preset + Apple MEI attrs
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF3",
        TlvAny.decode(f3Payload),
      );
      expect(t.activePresetHandle).not.toBeNull();
      expect(t.appleAttr0009).not.toBeNull();
      expect(t.appleAttr000B).not.toBeNull();
      expect(t.appleAttr000C).toBeNull();
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      );

      calls = [];
      await remoteInvoke(
        client,
        endpoint.number,
        AppleThermostatCluster,
        "appleCmdF4",
        emptyTlvStruct,
      );
      expect(t.activePresetHandle).toBeNull();
      expect(t.appleAttr0009).toBeNull();
      expect(t.appleAttr000B).toBeNull();
      expect(t.appleAttr000C).toBeNull();
      expect(calls).toEqual([]);
    });

    it("omits Presets and 0x1349 MEI from ServerMode thermostats when appleAdaptiveTemperature is false", async () => {
      const { endpoint } = await mountStandalone(false);
      const t = getThermostatState(endpoint);
      expect(t.attributeList).not.toContain(0x13490002);
      expect(t.attributeList).not.toContain(0x004e);
      expect(t.acceptedCommandList).not.toContain(0x134900f3);
      expect(t.acceptedCommandList).not.toContain(0x06);
    });

    it("persists presets, activePresetHandle, and Apple MEI attributes across ServerNode restart", async () => {
      const nodeId = "adaptive-persist-node";
      const occupiedHandle = createPresetHandle(
        Thermostat.PresetScenario.Occupied,
      );
      const sleepHandle = createPresetHandle(Thermostat.PresetScenario.Sleep);

      const first = await mountStandalone(true, nodeId);
      await first.endpoint.act(async (agent) => {
        const therm = agent.get(AppleThermostatServerBase) as unknown as {
          state: ThermostatClusterState;
          appleCmdF3(req: unknown): void;
        };
        therm.state.appleAttr0002 = false;
        therm.state.appleAttr0011 = { f0: true, f1: 2 };
        // Edit inactive Sleep preset to verify custom persistedPresets survive restart,
        // while Occupied matches makeHaState() temperature (20°C) so activePresetHandle stays valid.
        therm.state.persistedPresets = therm.state.persistedPresets.map((p) =>
          p.presetHandle !== null && Bytes.areEqual(p.presetHandle, sleepHandle)
            ? { ...p, heatingSetpoint: 1850 }
            : p,
        );
        const f3Payload = TlvObject({
          handle: TlvField(0, TlvByteString),
          duration: TlvField(1, TlvUInt32),
          flag: TlvField(2, TlvBoolean),
        }).encode({
          handle: occupiedHandle,
          duration: 86400,
          flag: false,
        });
        therm.appleCmdF3(TlvAny.decode(f3Payload));
      });

      await first.serverNode.close();
      server = undefined;

      initEnv();
      const second = await mountStandalone(true, nodeId);
      const t2 = getThermostatState(second.endpoint);
      expect(t2.appleAttr0002).toBe(false);
      expect(t2.appleAttr0011).toEqual({ f0: true, f1: 2 });
      const reloadedSleep = t2.persistedPresets.find(
        (p) =>
          p.presetHandle !== null &&
          Bytes.areEqual(p.presetHandle, sleepHandle),
      );
      expect(reloadedSleep?.heatingSetpoint).toBe(1850);
      expect(
        t2.activePresetHandle !== null &&
          Bytes.areEqual(t2.activePresetHandle, occupiedHandle),
      ).toBe(true);
      expect(
        t2.appleAttr0009 != null &&
          Bytes.areEqual(t2.appleAttr0009, occupiedHandle),
      ).toBe(true);
      expect(t2.appleAttr000B).not.toBeNull();
    });

    it("restores scheduled preset on startup when a persisted timed hold expired while offline", async () => {
      const nodeId = "adaptive-expired-hold-node";
      const sleepHandle = createPresetHandle(Thermostat.PresetScenario.Sleep);

      const first = await mountStandalone(true, nodeId);
      await first.endpoint.act(async (agent) => {
        const therm = agent.get(AppleThermostatServerBase) as unknown as {
          state: ThermostatClusterState;
        };
        therm.state.appleAttr0009 = sleepHandle;
        therm.state.appleAttr000C = 2;
        therm.state.appleAttr000E = false;
        therm.state.activePresetHandle = null;
        therm.state.temperatureSetpointHold =
          Thermostat.TemperatureSetpointHold.SetpointHoldOn;
        therm.state.temperatureSetpointHoldDuration = 180;
        // Expired 60s ago while server was offline
        therm.state.setpointHoldExpiryTimestamp =
          Math.floor(Date.now() / 1000) - 60;
      });

      await first.serverNode.close();
      server = undefined;

      initEnv();
      const second = await mountStandalone(true, nodeId);
      const t2 = getThermostatState(second.endpoint);
      await vi.waitFor(() => {
        expect(
          t2.activePresetHandle !== null &&
            Bytes.areEqual(t2.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t2.temperatureSetpointHold).toBe(
          Thermostat.TemperatureSetpointHold.SetpointHoldOff,
        );
        expect(t2.temperatureSetpointHoldDuration).toBeNull();
        expect(t2.setpointHoldExpiryTimestamp).toBeNull();
        expect(t2.appleAttr000C).toBeNull();
        expect(t2.appleAttr000E).toBe(true);
        expect(calls).toContainEqual({
          action: "climate.set_temperature",
          data: { temperature: 18 },
        });
      });
    });

    it("waits for an overlapping thermostat lock when End Hold restores the scheduled preset", async () => {
      const { endpoint, client } = await mountStandaloneAndCommission(true);
      const t = getThermostatState(endpoint);
      const sleepHandle = createPresetHandle(Thermostat.PresetScenario.Sleep);

      await remoteInvoke(
        client,
        endpoint.number,
        Thermostat,
        "setActivePresetRequest",
        { presetHandle: sleepHandle },
      );
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "occupiedHeatingSetpoint",
        2200,
      );
      expect(t.activePresetHandle).toBeNull();
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );

      // Hold an exclusive transaction lock right as temperatureSetpointHold$Changed fires so
      // the 0ms End Hold restore overlaps an active lock on thermostat.state.
      let contenderPromise: Promise<void> | undefined;
      let contenderAcquired = false;
      (
        endpoint.events as unknown as {
          thermostat: {
            temperatureSetpointHold$Changed: {
              once: (cb: () => void) => void;
            };
          };
        }
      ).thermostat.temperatureSetpointHold$Changed.once(() => {
        contenderPromise = Promise.resolve(
          endpoint.act(async (agent) => {
            const therm = agent.get(AppleThermostatServerBase);
            await agent.context.transaction.lock(therm);
            contenderAcquired = true;
            await new Promise((resolve) => setTimeout(resolve, 40));
          }),
        );
      });

      calls = [];
      await remoteWriteAttr(
        client,
        endpoint.number,
        Thermostat,
        "temperatureSetpointHold",
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      );
      await contenderPromise;
      expect(contenderAcquired).toBe(true);

      await vi.waitFor(() => {
        expect(
          t.activePresetHandle !== null &&
            Bytes.areEqual(t.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t.occupiedHeatingSetpoint).toBe(1800);
        expect(t.temperatureSetpointHold).toBe(
          Thermostat.TemperatureSetpointHold.SetpointHoldOff,
        );
        expect(t.appleAttr000C).toBeNull();
        expect(t.appleAttr000E).toBe(true);
        expect(calls).toEqual([
          { action: "climate.set_temperature", data: { temperature: 18 } },
        ]);
      });
    });

    it("isolates Presets, Hold, and 0x1349 MEI to appleAdaptiveTemperature without TimeSynchronization or BindingServer", async () => {
      const makeBridgeData = (appleAdaptiveTemperature: boolean) =>
        ({
          id: `isolation-${counter++}`,
          name: "Test Thermostat",
          port: 0,
          filter: { include: [], exclude: [], includeMode: "any" },
          featureFlags: {
            serverMode: true,
            appleAdaptiveTemperature,
          },
          basicInformation: {
            vendorId: 0xfff1,
            vendorName: "test",
            productId: 0x8000,
            productName: "test",
            productLabel: "test",
            hardwareVersion: 1,
            softwareVersion: 1,
          },
        }) as unknown as ConstructorParameters<typeof ServerModeServerNode>[1];

      const adaptiveBridge = makeBridgeData(true);
      const adaptiveServer = new ServerModeServerNode(env, adaptiveBridge);
      server = adaptiveServer;
      await adaptiveServer.construction;

      expect("timeSynchronization" in adaptiveServer.behaviors.supported).toBe(
        false,
      );
      expect("binding" in adaptiveServer.behaviors.supported).toBe(false);
      expect(adaptiveServer.state.basicInformation.vendorId).toBe(0x115f);
      expect(adaptiveServer.state.basicInformation.productId).toBe(0x4801);

      const stateWithFanAndPower = makeHaState({
        attributes: {
          supported_features:
            ClimateDeviceFeature.TARGET_TEMPERATURE |
            ClimateDeviceFeature.TARGET_TEMPERATURE_RANGE |
            ClimateDeviceFeature.FAN_MODE |
            ClimateDeviceFeature.TURN_ON |
            ClimateDeviceFeature.TURN_OFF,
          fan_modes: ["auto", "on"],
          fan_mode: "auto",
        },
      });
      const haEntity = {
        entity: {
          entity_id: CLIMATE_ID,
          state: stateWithFanAndPower as never,
          registry: undefined as never,
          deviceRegistry: undefined as never,
        },
        mapping: undefined,
      };

      const adaptiveType = asStandaloneEndpointType(
        ClimateDevice(haEntity, true, true),
      );
      expect(adaptiveType.deviceType).toBe(0x0301);
      expect(Object.keys(adaptiveType.behaviors)).not.toContain("fanControl");
      expect(Object.keys(adaptiveType.behaviors)).not.toContain("onOff");
      expect(Object.keys(adaptiveType.behaviors)).not.toContain("binding");
      expect(Object.keys(adaptiveType.behaviors)).not.toContain(
        "bridgedDeviceBasicInformation",
      );

      const ep = new Endpoint(adaptiveType, { id: "climate-living-room" });
      await adaptiveServer.addDevice(ep);
      await adaptiveServer.updateAdvertisedDeviceType(DeviceTypeId(769));
      await ep.construction;

      const tState = (
        ep.state as unknown as { thermostat: Record<string, unknown> }
      ).thermostat;
      expect(tState.numberOfPresets).toBe(10);
      expect(
        (tState.presetTypes as Array<{ presetScenario: number }>).length,
      ).toBe(6);
      expect(tState.appleAttr0002).toBe(true);
      expect(tState.appleAttr000F).toBe(1);
      expect(tState.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      );
      expect(tState.temperatureSetpointHoldDuration).toBeNull();
      expect(tState.setpointHoldExpiryTimestamp).toBeNull();

      const standardType = ClimateDevice(haEntity, true, false);
      expect(standardType.deviceType).toBe(0x0072);
      expect(Object.keys(standardType.behaviors)).toContain("fanControl");
      expect(Object.keys(standardType.behaviors)).toContain("onOff");
      expect(Object.keys(standardType.behaviors)).not.toContain("binding");

      const standardEp = new Endpoint(asStandaloneEndpointType(standardType), {
        id: "climate-standard",
      });
      const standardServer = new ServerModeServerNode(
        env,
        makeBridgeData(false),
      );
      try {
        await standardServer.construction;
        expect(
          "timeSynchronization" in standardServer.behaviors.supported,
        ).toBe(false);
        expect("binding" in standardServer.behaviors.supported).toBe(false);
        await standardServer.addDevice(standardEp);
        await standardEp.construction;
        const standardState = (
          standardEp.state as unknown as {
            thermostat: Record<string, unknown>;
          }
        ).thermostat;
        expect(standardState.temperatureSetpointHold).toBeUndefined();
        expect(standardState.appleAttr0002).toBeUndefined();
      } finally {
        await standardServer.close().catch(() => {});
      }
    });

    it("processes all sibling attributes in multi-attribute WriteRequest batches without swallowing hold or End Hold transitions", async () => {
      const { endpoint, client } = await mountStandaloneAndCommission(true);
      const t = getThermostatState(endpoint);
      const sleepHandle = createPresetHandle(Thermostat.PresetScenario.Sleep);

      await remoteInvoke(
        client,
        endpoint.number,
        Thermostat,
        "setActivePresetRequest",
        { presetHandle: sleepHandle },
      );

      // 1. [occupiedHeatingSetpoint = 2200, temperatureSetpointHoldDuration = 180] in one WriteRequest
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: Thermostat,
          attributes: "occupiedHeatingSetpoint",
          value: 2200,
        },
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHoldDuration",
          value: 180,
        },
      ]);
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBe(180);
      expect(t.setpointHoldExpiryTimestamp).not.toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(false);

      // 2. [temperatureSetpointHoldDuration = null, temperatureSetpointHold = SetpointHoldOff] straight from 180m hold
      calls = [];
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHoldDuration",
          value: null,
        },
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHold",
          value: Thermostat.TemperatureSetpointHold.SetpointHoldOff,
        },
      ]);
      await vi.waitFor(() => {
        expect(
          t.activePresetHandle !== null &&
            Bytes.areEqual(t.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t.occupiedHeatingSetpoint).toBe(1800);
        expect(t.appleAttr000C).toBeNull();
        expect(t.appleAttr000E).toBe(true);
        expect(calls).toEqual([
          { action: "climate.set_temperature", data: { temperature: 18 } },
        ]);
      });

      // 3. [temperatureSetpointHold = SetpointHoldOn, temperatureSetpointHoldDuration = 180] from Off/null
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHold",
          value: Thermostat.TemperatureSetpointHold.SetpointHoldOn,
        },
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHoldDuration",
          value: 180,
        },
      ]);
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBe(180);
      expect(t.setpointHoldExpiryTimestamp).not.toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(false);

      // 4a. [temperatureSetpointHoldDuration = 180, appleAttr000E = true] while SetpointHoldOn -> clears duration & expiry
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHoldDuration",
          value: 180,
        },
        {
          cluster: AppleThermostatCluster,
          attributes: "appleAttr000E",
          value: true,
        },
      ]);
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBeNull();
      expect(t.setpointHoldExpiryTimestamp).toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(true);

      // 4b. Reversed order [appleAttr000E = true, temperatureSetpointHoldDuration = 180] -> arms 180m hold & sets 000E = false
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: AppleThermostatCluster,
          attributes: "appleAttr000E",
          value: true,
        },
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHoldDuration",
          value: 180,
        },
      ]);
      expect(t.temperatureSetpointHold).toBe(
        Thermostat.TemperatureSetpointHold.SetpointHoldOn,
      );
      expect(t.temperatureSetpointHoldDuration).toBe(180);
      expect(t.setpointHoldExpiryTimestamp).not.toBeNull();
      expect(t.appleAttr000C).toBe(2);
      expect(t.appleAttr000E).toBe(false);

      // 5. [occupiedHeatingSetpoint = 2200, temperatureSetpointHold = SetpointHoldOff] -> End Hold still restores Sleep
      calls = [];
      await remoteWriteAttrs(client, endpoint.number, [
        {
          cluster: Thermostat,
          attributes: "occupiedHeatingSetpoint",
          value: 2200,
        },
        {
          cluster: Thermostat,
          attributes: "temperatureSetpointHold",
          value: Thermostat.TemperatureSetpointHold.SetpointHoldOff,
        },
      ]);
      await vi.waitFor(() => {
        expect(
          t.activePresetHandle !== null &&
            Bytes.areEqual(t.activePresetHandle, sleepHandle),
        ).toBe(true);
        expect(t.occupiedHeatingSetpoint).toBe(1800);
        expect(t.temperatureSetpointHold).toBe(
          Thermostat.TemperatureSetpointHold.SetpointHoldOff,
        );
        expect(t.appleAttr000C).toBeNull();
        expect(t.appleAttr000E).toBe(true);
      });
    });
  },
);
