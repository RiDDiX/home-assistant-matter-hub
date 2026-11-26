import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import {
  ClimateDeviceFeature,
  ClimateHvacMode,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { TimeSynchronization } from "@matter/main/clusters";
import { Endpoint, type ServerNode } from "@matter/main/node";
import { DeviceTypeId } from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "./endpoints/aggregator-endpoint.js";
import { BridgeServerNode } from "./endpoints/bridge-server-node.js";
import { ClimateDevice } from "./endpoints/legacy/climate/index.js";
import { ServerModeServerNode } from "./endpoints/server-mode-server-node.js";
import { asStandaloneEndpointType } from "./endpoints/standalone-endpoint-type.js";
import { RootTimeSynchronizationServer } from "./time-synchronization.js";

let dir: string;
let node: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-timesync-"));
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function env(): Environment {
  const e = new Environment("test", Environment.default);
  e.get(VariableService).set("storage.path", dir);
  e.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
  } as unknown as HomeAssistantConfig);
  e.set(HomeAssistantActions, {
    call() {},
    fireEvent() {},
  } as unknown as HomeAssistantActions);
  e.set(
    BridgeDataProvider,
    new BridgeDataProvider(makeBridgeData(true) as never),
  );
  e.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
  } as unknown as EntityStateProvider);
  return e;
}

function makeBridgeData(serverMode = false): BridgeData {
  return {
    id: serverMode ? "server-climate-test" : "bridge-timesync-test",
    name: "Ecobee Test",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { serverMode },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "test",
      productId: 0x8000,
      productName: "test",
      productLabel: "test",
      hardwareVersion: 1,
      softwareVersion: 1,
    },
  };
}

function makeClimateState() {
  return {
    entity_id: "climate.living_room",
    state: "heat_cool",
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00Z",
    last_updated: "2026-01-01T00:00:00Z",
    attributes: {
      friendly_name: "Living Room",
      supported_features:
        ClimateDeviceFeature.TARGET_TEMPERATURE |
        ClimateDeviceFeature.TARGET_TEMPERATURE_RANGE,
      hvac_modes: [
        ClimateHvacMode.off,
        ClimateHvacMode.heat,
        ClimateHvacMode.cool,
        ClimateHvacMode.heat_cool,
      ],
      current_temperature: 21,
      target_temp_low: 20,
      target_temp_high: 24,
      min_temp: 7,
      max_temp: 33,
      current_humidity: 40,
    },
  };
}

describe("RootTimeSynchronizationServer and standalone climate endpoint", () => {
  it("omits TimeSynchronization and BindingServer when appleAdaptiveTemperature is disabled", async () => {
    const bridge = new BridgeServerNode(
      env(),
      makeBridgeData(false),
      new AggregatorEndpoint("aggregator"),
    );
    node = bridge;
    await bridge.construction;

    expect("timeSynchronization" in bridge.behaviors.supported).toBe(false);
    expect("binding" in bridge.behaviors.supported).toBe(false);

    const standardServer = new ServerModeServerNode(
      env(),
      makeBridgeData(true),
    );
    try {
      await standardServer.construction;
      expect("timeSynchronization" in standardServer.behaviors.supported).toBe(
        false,
      );
      expect("binding" in standardServer.behaviors.supported).toBe(false);
    } finally {
      await standardServer.close().catch(() => {});
    }
  });

  it("mounts TimeSynchronization with TimeZone on adaptive root node and handles commands", async () => {
    const adaptiveBridge: BridgeData = {
      ...makeBridgeData(true),
      featureFlags: { serverMode: true, appleAdaptiveTemperature: true },
    };
    const serverNode = new ServerModeServerNode(env(), adaptiveBridge);
    node = serverNode;
    await serverNode.construction;

    expect("binding" in serverNode.behaviors.supported).toBe(false);
    const tsState = serverNode.stateOf(RootTimeSynchronizationServer);
    expect(tsState.utcTime).not.toBeNull();
    expect(tsState.localTime).not.toBeNull();
    expect(tsState.granularity).toBe(
      TimeSynchronization.Granularity.SecondsGranularity,
    );
    expect(tsState.timeZone.length).toBe(1);
    expect(tsState.timeZoneListMaxSize).toBe(2);
    expect(tsState.dstOffsetListMaxSize).toBe(2);

    await serverNode.act((agent) => {
      const ts = agent.get(RootTimeSynchronizationServer);
      const tzResp = ts.setTimeZone({
        timeZone: [{ offset: -18000, validAt: 0, name: "America/New_York" }],
      });
      expect(tzResp.dstOffsetRequired).toBe(true);
      ts.setDstOffset({
        dstOffset: [{ offset: 3600, validStarting: 0, validUntil: null }],
      });
      ts.setUtcTime({
        utcTime: 1_794_924_000_000_000,
        granularity: TimeSynchronization.Granularity.MillisecondsGranularity,
        timeSource: TimeSynchronization.TimeSource.Admin,
      });
    });

    const updated = serverNode.stateOf(RootTimeSynchronizationServer);
    expect(updated.timeZone[0].offset).toBe(-18000);
    expect(updated.dstOffset[0].offset).toBe(3600);
    expect(Number(updated.localTime)).toBe(
      1_794_924_000_000_000 + (-18000 + 3600) * 1_000_000,
    );

    // Verify 2-entry timeZone schedule selects entry 2 once utcTime >= validAt
    // and raw Matter-epoch utcTime (< 946_684_800_000_000) is normalized cleanly.
    await serverNode.act((agent) => {
      const ts = agent.get(RootTimeSynchronizationServer);
      ts.setTimeZone({
        timeZone: [
          { offset: -18000, validAt: 0, name: "America/New_York" },
          {
            offset: -28800,
            validAt: 848_239_200_000_000,
            name: "America/Los_Angeles",
          },
        ],
      });
      ts.setDstOffset({
        dstOffset: [{ offset: 0, validStarting: 0, validUntil: null }],
      });
      ts.setUtcTime({
        utcTime: 848_240_000_000_000, // Matter epoch us -> + 946_684_800_000_000 Unix us
        granularity: TimeSynchronization.Granularity.SecondsGranularity,
      });
    });

    const tzSwitched = serverNode.stateOf(RootTimeSynchronizationServer);
    expect(Number(tzSwitched.utcTime)).toBe(
      946_684_800_000_000 + 848_240_000_000_000,
    );
    expect(Number(tzSwitched.localTime)).toBe(
      946_684_800_000_000 + 848_240_000_000_000 - 28800 * 1_000_000,
    );

    // Verify out-of-window future DST entry yields dstOffsetSec = 0 (not dstOffset[0]),
    // Matter epoch floor underflow returns localTime = null, TimeSource.None promotes to Admin,
    // and invalid Granularity / validUntil are rejected.
    await serverNode.act((agent) => {
      const ts = agent.get(RootTimeSynchronizationServer);
      ts.setTimeZone({
        timeZone: [{ offset: -18000, validAt: 0, name: "America/New_York" }],
      });
      ts.setDstOffset({
        dstOffset: [
          {
            offset: 3600,
            validStarting: 1_800_000_000_000_000,
            validUntil: 1_810_000_000_000_000,
          },
        ],
      });
      ts.setUtcTime({
        utcTime: 1_794_924_000_000_000,
        granularity: TimeSynchronization.Granularity.SecondsGranularity,
        timeSource: TimeSynchronization.TimeSource.None,
      });
    });

    const outOfWindowDst = serverNode.stateOf(RootTimeSynchronizationServer);
    expect(outOfWindowDst.timeSource).toBe(
      TimeSynchronization.TimeSource.Admin,
    );
    expect(Number(outOfWindowDst.localTime)).toBe(
      1_794_924_000_000_000 - 18000 * 1_000_000,
    );

    await serverNode.act((agent) => {
      const ts = agent.get(RootTimeSynchronizationServer);
      ts.setUtcTime({
        utcTime: 0,
        granularity: TimeSynchronization.Granularity.SecondsGranularity,
      });
    });
    expect(
      serverNode.stateOf(RootTimeSynchronizationServer).localTime,
    ).toBeNull();

    await serverNode.act((agent) => {
      const ts = agent.get(RootTimeSynchronizationServer);
      expect(() =>
        ts.setUtcTime({
          utcTime: 1_794_924_000_000_000,
          granularity: TimeSynchronization.Granularity.NoTimeGranularity,
        }),
      ).toThrow();
      expect(() =>
        ts.setDstOffset({
          dstOffset: [
            {
              offset: 3600,
              validStarting: 1_800_000_000_000_000,
              validUntil: 1_800_000_000_000_000,
            },
          ],
        }),
      ).toThrow();
    });
  });

  it("isolates Presets and 0x1349 MEI to appleAdaptiveTemperature endpoints without BindingServer", async () => {
    const adaptiveBridge: BridgeData = {
      ...makeBridgeData(true),
      featureFlags: { serverMode: true, appleAdaptiveTemperature: true },
    };
    const serverNode = new ServerModeServerNode(env(), adaptiveBridge);
    node = serverNode;
    await serverNode.construction;

    expect(serverNode.state.basicInformation.vendorId).toBe(0x115f);
    expect(serverNode.state.basicInformation.productId).toBe(0x4801);

    const stateWithFanAndPower = {
      ...makeClimateState(),
      attributes: {
        ...makeClimateState().attributes,
        supported_features:
          ClimateDeviceFeature.TARGET_TEMPERATURE |
          ClimateDeviceFeature.TARGET_TEMPERATURE_RANGE |
          ClimateDeviceFeature.FAN_MODE |
          ClimateDeviceFeature.TURN_ON |
          ClimateDeviceFeature.TURN_OFF,
        fan_modes: ["auto", "on"],
        fan_mode: "auto",
      },
    };
    const haState = {
      entity: {
        entity_id: "climate.living_room",
        state: stateWithFanAndPower as never,
        registry: undefined as never,
        deviceRegistry: undefined as never,
      },
      mapping: undefined,
    };

    const adaptiveType = asStandaloneEndpointType(
      ClimateDevice(haState, true, true),
    );
    expect(adaptiveType.deviceType).toBe(0x0301);
    expect(Object.keys(adaptiveType.behaviors)).not.toContain("fanControl");
    expect(Object.keys(adaptiveType.behaviors)).not.toContain("onOff");
    expect(Object.keys(adaptiveType.behaviors)).not.toContain("binding");
    expect(Object.keys(adaptiveType.behaviors)).not.toContain(
      "bridgedDeviceBasicInformation",
    );

    const ep = new Endpoint(adaptiveType, { id: "climate-living-room" });
    await serverNode.addDevice(ep);
    await serverNode.updateAdvertisedDeviceType(DeviceTypeId(769));
    await ep.construction;

    const tState = (
      ep.state as unknown as { thermostat: Record<string, unknown> }
    ).thermostat;
    expect(tState.numberOfPresets).toBe(10);
    expect(
      (tState.presetTypes as Array<{ presetScenario: number }>).length,
    ).toBe(6);
    expect(tState.appleAttr0002).toBe(true);
    expect(tState.temperatureSetpointHold).toBeUndefined();

    const standardType = ClimateDevice(haState, true, false);
    expect(standardType.deviceType).toBe(0x0072);
    expect(Object.keys(standardType.behaviors)).toContain("fanControl");
    expect(Object.keys(standardType.behaviors)).toContain("onOff");
    expect(Object.keys(standardType.behaviors)).not.toContain("binding");
  });
});
