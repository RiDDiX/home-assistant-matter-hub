import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Thermostat } from "@matter/main/clusters";
import { ThermostatDevice } from "@matter/main/devices";
import { Endpoint, ServerNode } from "@matter/main/node";
import {
  TlvAny,
  TlvBoolean,
  TlvByteString,
  TlvField,
  TlvObject,
  TlvUInt16,
  TlvUInt32,
} from "@matter/main/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppleThermostatServerBase,
  MAX_NULLABLE_EPOCH_S,
} from "./apple-adaptive-temperature.js";

const APPLE_THERMOSTAT_ATTR_IDS = [
  0x13490002, 0x13490009, 0x1349000a, 0x1349000b, 0x1349000c, 0x1349000d,
  0x1349000e, 0x1349000f, 0x13490010, 0x13490011, 0x13490012, 0x13490013,
];

const APPLE_THERMOSTAT_CMD_IDS = [
  0x134900f3, 0x134900f4, 0x134900f5, 0x134900f6, 0x134900f7, 0x134900f8,
  0x134900f9,
];

let dir: string;
let node: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-apple-mei-"));
});

afterEach(async () => {
  await node?.close().catch(() => {});
  node = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("Apple 0x1349 Adaptive Temperature MEI extensions", () => {
  it("exposes 0x1349 attributes/commands on Thermostat without FC05/FC06 and handles F3/F4", async () => {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);

    const FeaturedThermostat = AppleThermostatServerBase.with(
      "Heating",
      "Cooling",
      "AutoMode",
      "Presets",
    ).set({
      localTemperature: 2100,
      occupiedHeatingSetpoint: 2000,
      occupiedCoolingSetpoint: 2400,
      minHeatSetpointLimit: 450,
      maxHeatSetpointLimit: 3700,
      absMinHeatSetpointLimit: 450,
      absMaxHeatSetpointLimit: 3700,
      minCoolSetpointLimit: 450,
      maxCoolSetpointLimit: 3700,
      absMinCoolSetpointLimit: 450,
      absMaxCoolSetpointLimit: 3700,
      minSetpointDeadBand: 0,
      controlSequenceOfOperation:
        Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
      systemMode: Thermostat.SystemMode.Auto,
      activePresetHandle: null,
      temperatureSetpointHold:
        Thermostat.TemperatureSetpointHold.SetpointHoldOff,
      temperatureSetpointHoldDuration: null,
      setpointHoldExpiryTimestamp: null,
      numberOfPresets: 10,
      presetTypes: [
        {
          presetScenario: Thermostat.PresetScenario.Occupied,
          numberOfPresets: 1,
          presetTypeFeatures: { automatic: true, supportsNames: true },
        },
      ],
      persistedPresets: [
        {
          presetHandle: new Uint8Array([1]),
          presetScenario: Thermostat.PresetScenario.Occupied,
          name: null,
          heatingSetpoint: 2000,
          coolingSetpoint: 2333,
          builtIn: true,
        },
      ],
    } as Record<string, unknown>);

    // the hold logic lives on the Adaptive thermostat classes, F9 only decodes
    const holdCalls: [boolean, number | null][] = [];
    class HoldSpyThermostat extends FeaturedThermostat {
      applyAppleSetpointHold(
        resumeOnNextEvent: boolean,
        durationMinutes: number | null,
      ) {
        holdCalls.push([resumeOnNextEvent, durationMinutes]);
      }
    }

    node = await ServerNode.create({
      id: "apple-mei-test",
      environment: env,
      network: { port: 0 },
    });

    const epType = ThermostatDevice.with(HoldSpyThermostat);
    const ep = new Endpoint(epType, { id: "thermostat-1" });
    await node.add(ep);
    await node.start();

    const desc = ep.stateOf("descriptor" as never) as {
      serverList: number[];
      clientList: number[];
    };
    expect(desc.serverList).toContain(0x0201);
    expect(desc.serverList).not.toContain(0x1349fc05);
    expect(desc.clientList).not.toContain(0x1349fc06);

    const schema = FeaturedThermostat.schema;
    expect(
      schema.conformant.attributes(0x13490002)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490009)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x1349000b)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x1349000e)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490010)?.effectiveQuality.atomic,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490010)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490011)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490012)?.effectiveQuality.nonvolatile,
    ).toBe(true);
    expect(
      schema.conformant.attributes(0x13490013)?.effectiveQuality.nonvolatile,
    ).toBe(true);

    const therm = ep.stateOf("thermostat" as never) as Record<string, unknown>;
    const attrList = therm.attributeList as number[];
    const cmdList = therm.acceptedCommandList as number[];

    for (const id of APPLE_THERMOSTAT_ATTR_IDS) {
      expect(attrList).toContain(id);
    }
    for (const id of APPLE_THERMOSTAT_CMD_IDS) {
      expect(cmdList).toContain(id);
    }

    expect(therm.appleAttr0002).toBe(true);
    expect(therm.appleAttr000D).toBe(1);
    expect(therm.appleAttr000E).toBe(true);
    expect(therm.appleAttr000F).toBe(1);
    expect(therm.appleAttr0010).toHaveLength(5);
    expect(therm.appleAttr0011).toEqual({ f0: true, f1: null });

    const appleF3Payload = TlvObject({
      handle: TlvField(0, TlvByteString),
      duration: TlvField(1, TlvUInt32),
      flag: TlvField(2, TlvBoolean),
    }).encode({
      handle: new Uint8Array([1]),
      duration: 86400,
      flag: false,
    });

    const beforeUnix = Math.floor(Date.now() / 1000);
    await ep.act(async (agent) => {
      const tBehavior = agent.get(HoldSpyThermostat) as unknown as {
        state: Record<string, unknown>;
        appleCmdF3(req: unknown): unknown;
        appleCmdF4(req: unknown): unknown;
      };
      tBehavior.state.appleAttr0002 = false;
      expect(tBehavior.state.appleAttr0002).toBe(false);
      tBehavior.state.appleAttr0002 = true;
      expect(tBehavior.state.appleAttr0002).toBe(true);

      tBehavior.state.appleAttr0011 = { f0: true };
      expect(tBehavior.state.appleAttr0011).toEqual({ f0: true });
      tBehavior.state.appleAttr0011 = { f0: true, f1: 1 };
      expect(tBehavior.state.appleAttr0011).toEqual({ f0: true, f1: 1 });

      expect(() =>
        tBehavior.appleCmdF3(TlvAny.decode(appleF3Payload)),
      ).not.toThrow();
      expect(tBehavior.state.appleAttr0009).toEqual(new Uint8Array([1]));
      const expiryAfterF3 = tBehavior.state.appleAttr000B as number;
      expect(expiryAfterF3).toBeGreaterThanOrEqual(beforeUnix + 86390);
      expect(tBehavior.state.activePresetHandle).toEqual(new Uint8Array([1]));

      // Unknown preset handle throws before mutating appleAttr0009/000B
      const unknownPayload = TlvObject({
        handle: TlvField(0, TlvByteString),
        duration: TlvField(1, TlvUInt32),
        flag: TlvField(2, TlvBoolean),
      }).encode({
        handle: new Uint8Array([99]),
        duration: 3600,
        flag: false,
      });
      expect(() =>
        tBehavior.appleCmdF3(TlvAny.decode(unknownPayload)),
      ).toThrow();
      expect(tBehavior.state.appleAttr0009).toEqual(new Uint8Array([1]));
      expect(tBehavior.state.appleAttr000B).toBe(expiryAfterF3);

      // Indefinite duration (0xFFFFFFFF) must not overflow TlvEpochS
      const indefinitePayload = TlvObject({
        handle: TlvField(0, TlvByteString),
        duration: TlvField(1, TlvUInt32),
        flag: TlvField(2, TlvBoolean),
      }).encode({
        handle: new Uint8Array([1]),
        duration: 0xffffffff,
        flag: false,
      });
      expect(() =>
        tBehavior.appleCmdF3(TlvAny.decode(indefinitePayload)),
      ).not.toThrow();
      expect(tBehavior.state.appleAttr0009).toEqual(new Uint8Array([1]));
      expect(tBehavior.state.appleAttr000B).toBeNull();

      // Large durationSec near UINT32_MAX (0xfffffffe) must clamp to MAX_NULLABLE_EPOCH_S
      // without overflowing nullable epoch-s (0xffffffff is reserved as null sentinel)
      const nearMaxPayload = TlvObject({
        handle: TlvField(0, TlvByteString),
        duration: TlvField(1, TlvUInt32),
        flag: TlvField(2, TlvBoolean),
      }).encode({
        handle: new Uint8Array([1]),
        duration: 0xfffffffe,
        flag: false,
      });
      expect(() =>
        tBehavior.appleCmdF3(TlvAny.decode(nearMaxPayload)),
      ).not.toThrow();
      expect(tBehavior.state.appleAttr000B).toBe(MAX_NULLABLE_EPOCH_S);

      // Missing field 0 must be ignored rather than clearing the active preset
      const emptyPayload = TlvObject({}).encode({});
      expect(() =>
        tBehavior.appleCmdF3(TlvAny.decode(emptyPayload)),
      ).not.toThrow();
      expect(tBehavior.state.appleAttr0009).toEqual(new Uint8Array([1]));
      expect(tBehavior.state.activePresetHandle).toEqual(new Uint8Array([1]));

      // appleCmdF9 { 0: false, 1: 180 } -> timed hold ("For 3 hours") while Adaptive enabled
      const f9ThreeHours = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
        durationMinutes: TlvField(1, TlvUInt16),
      }).encode({ resumeOnNextEvent: false, durationMinutes: 180 });
      const tBehaviorWithF9 = tBehavior as unknown as {
        state: Record<string, unknown>;
        appleCmdF9(req: unknown): unknown;
      };
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(f9ThreeHours));

      // appleCmdF9 { 0: false } -> Indefinitely
      const f9Indefinite = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
      }).encode({ resumeOnNextEvent: false });
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(f9Indefinite));

      // appleCmdF9 { 0: true } -> Holding until next event
      const f9NextEvent = TlvObject({
        resumeOnNextEvent: TlvField(0, TlvBoolean),
      }).encode({ resumeOnNextEvent: true });
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(f9NextEvent));

      // Invalid/missing field 0 is ignored
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(emptyPayload));
      expect(holdCalls).toEqual([
        [false, 180],
        [false, null],
        [true, null],
      ]);

      // Pre-2000 host clock must fall back to null instead of underflowing TlvEpochS
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(500_000_000_000);
      try {
        expect(() =>
          tBehavior.appleCmdF3(TlvAny.decode(appleF3Payload)),
        ).not.toThrow();
        expect(tBehavior.state.appleAttr000B).toBeNull();
      } finally {
        dateSpy.mockRestore();
      }

      expect(() => tBehavior.appleCmdF4([])).not.toThrow();
      expect(tBehavior.state.appleAttr0009).toBeNull();
      expect(tBehavior.state.appleAttr000B).toBeNull();
      expect(tBehavior.state.activePresetHandle).toBeNull();

      // appleCmdF9 is ignored when Adaptive Temperature is disabled
      holdCalls.length = 0;
      tBehavior.state.appleAttr0002 = false;
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(f9ThreeHours));
      tBehavior.state.appleAttr0002 = true;
      tBehavior.state.appleAttr0011 = { f0: false, f1: null };
      tBehaviorWithF9.appleCmdF9(TlvAny.decode(f9ThreeHours));
      expect(holdCalls).toEqual([]);
    });
  });
});
