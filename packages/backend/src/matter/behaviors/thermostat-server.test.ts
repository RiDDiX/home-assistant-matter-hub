import type {
  ClimateDeviceAttributes,
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { ActionContext } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../services/home-assistant/home-assistant-config.js";
import { ClimateThermostatServer } from "../endpoints/legacy/climate/behaviors/climate-thermostat-server.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import {
  createPresetHandle,
  repairSetpointLimits,
  ThermostatServer,
  ThermostatServerBase,
  type ThermostatServerConfig,
  thermostatPreInitialize,
} from "./thermostat-server.js";

interface MockThermostatBehavior {
  persistedPresetsChanged(
    newPresets: Thermostat.Preset[],
    oldPresets: Thermostat.Preset[],
    context?: unknown,
  ): void;
}

describe("repairSetpointLimits (#375)", () => {
  it("lowers a drifted absMin so absMin <= min", () => {
    expect(
      repairSetpointLimits({
        absMin: 6100,
        min: 1611,
        max: 3000,
        absMax: 3000,
      }),
    ).toEqual({ absMin: 1611, min: 1611, max: 3000, absMax: 3000 });
  });

  it("raises a drifted absMax so max <= absMax", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: 1600, max: 3000, absMax: 2000 }),
    ).toEqual({ absMin: 0, min: 1600, max: 3000, absMax: 3000 });
  });

  it("orders inverted regular limits", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: 3000, max: 1600, absMax: 5000 }),
    ).toEqual({ absMin: 0, min: 1600, max: 3000, absMax: 5000 });
  });

  it("keeps sub-zero limits (no clamp to 0)", () => {
    expect(
      repairSetpointLimits({ absMin: 0, min: -1800, max: 500, absMax: 500 }),
    ).toEqual({ absMin: -1800, min: -1800, max: 500, absMax: 500 });
  });

  it("leaves a valid set unchanged", () => {
    expect(
      repairSetpointLimits({ absMin: 700, min: 1600, max: 3000, absMax: 3200 }),
    ).toEqual({ absMin: 700, min: 1600, max: 3000, absMax: 3200 });
  });
});

describe("thermostatPreInitialize recovers a stuck device (#375)", () => {
  it("repairs a persisted absMin 6100 > min 1611 before validation", () => {
    const self = {
      features: { heating: true, cooling: true, autoMode: false },
      state: {
        localTemperature: 2100,
        absMinHeatSetpointLimit: 6100,
        minHeatSetpointLimit: 1611,
        maxHeatSetpointLimit: 3000,
        absMaxHeatSetpointLimit: 3000,
        occupiedHeatingSetpoint: 2000,
        absMinCoolSetpointLimit: 6100,
        minCoolSetpointLimit: 1611,
        maxCoolSetpointLimit: 3000,
        absMaxCoolSetpointLimit: 3000,
        occupiedCoolingSetpoint: 2400,
      },
    };
    thermostatPreInitialize(
      self as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const s = self.state;
    expect(s.absMinHeatSetpointLimit).toBeLessThanOrEqual(
      s.minHeatSetpointLimit,
    );
    expect(s.minHeatSetpointLimit).toBeLessThanOrEqual(s.maxHeatSetpointLimit);
    expect(s.maxHeatSetpointLimit).toBeLessThanOrEqual(
      s.absMaxHeatSetpointLimit,
    );
    expect(s.absMinCoolSetpointLimit).toBeLessThanOrEqual(
      s.minCoolSetpointLimit,
    );
    expect(s.absMinHeatSetpointLimit).toBe(1611);
  });
});

describe("ThermostatServer feature variants", () => {
  const mockConfig: ThermostatServerConfig = {
    supportsTemperatureRange: () => false,
    getMinTemperature: () => undefined,
    getMaxTemperature: () => undefined,
    getCurrentTemperature: () => undefined,
    getTargetHeatingTemperature: () => undefined,
    getTargetCoolingTemperature: () => undefined,
    getSystemMode: () => 4,
    getRunningMode: () => 0,
    getControlSequence: () => 2,
    setSystemMode: () => ({ action: "mock" }) as unknown as HomeAssistantAction,
    setTargetTemperature: () =>
      ({ action: "mock" }) as unknown as HomeAssistantAction,
    setTargetTemperatureRange: () =>
      ({ action: "mock" }) as unknown as HomeAssistantAction,
  };

  it("omits Presets on all 4 standard feature variants when adaptive temperature is disabled", () => {
    const heatOnly = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: false },
    );
    expect(heatOnly.features.heating).toBe(true);
    expect(heatOnly.features.cooling).toBe(false);
    expect(heatOnly.features.presets).toBe(false);

    const coolOnly = ThermostatServer(
      mockConfig,
      {},
      { heating: false, cooling: true },
    );
    expect(coolOnly.features.heating).toBe(false);
    expect(coolOnly.features.cooling).toBe(true);
    expect(coolOnly.features.presets).toBe(false);

    const heatAndCool = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: true },
    );
    expect(heatAndCool.features.heating).toBe(true);
    expect(heatAndCool.features.cooling).toBe(true);
    expect(heatAndCool.features.presets).toBe(false);

    const full = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: true, autoMode: true },
    );
    expect(full.features.heating).toBe(true);
    expect(full.features.cooling).toBe(true);
    expect(full.features.autoMode).toBe(true);
    expect(full.features.presets).toBe(false);
  });

  it("enables Presets on all 4 feature variants when appleAdaptiveTemperature is true", () => {
    const heatOnly = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: false },
      true,
    );
    expect(heatOnly.features.heating).toBe(true);
    expect(heatOnly.features.cooling).toBe(false);
    expect(heatOnly.features.presets).toBe(true);
    expect(
      (heatOnly.defaults as unknown as Record<string, unknown>).numberOfPresets,
    ).toBe(10);
    expect(
      (heatOnly.defaults as unknown as Record<string, unknown>)
        .activePresetHandle,
    ).toBeNull();
    expect(
      (heatOnly.defaults as unknown as Record<string, unknown>).presetTypes,
    ).toHaveLength(6);

    const coolOnly = ThermostatServer(
      mockConfig,
      {},
      { heating: false, cooling: true },
      true,
    );
    expect(coolOnly.features.heating).toBe(false);
    expect(coolOnly.features.cooling).toBe(true);
    expect(coolOnly.features.presets).toBe(true);
    expect(
      (coolOnly.defaults as unknown as Record<string, unknown>).numberOfPresets,
    ).toBe(10);

    const heatAndCool = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: true },
      true,
    );
    expect(heatAndCool.features.heating).toBe(true);
    expect(heatAndCool.features.cooling).toBe(true);
    expect(heatAndCool.features.presets).toBe(true);
    expect(
      (heatAndCool.defaults as unknown as Record<string, unknown>)
        .numberOfPresets,
    ).toBe(10);

    const full = ThermostatServer(
      mockConfig,
      {},
      { heating: true, cooling: true, autoMode: true },
      true,
    );
    expect(full.features.heating).toBe(true);
    expect(full.features.cooling).toBe(true);
    expect(full.features.autoMode).toBe(true);
    expect(full.features.presets).toBe(true);
    expect(
      (full.defaults as unknown as Record<string, unknown>).numberOfPresets,
    ).toBe(10);
  });
});

describe("thermostatPreInitialize with Presets", () => {
  it("seeds 5 builtIn presets for heating-only device", () => {
    const self = {
      features: { heating: true, cooling: false, presets: true },
      state: {
        minHeatSetpointLimit: 700,
        maxHeatSetpointLimit: 3500,
      },
    };
    thermostatPreInitialize(
      self as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const state = self.state as unknown as {
      presetTypes: unknown[];
      numberOfPresets: number;
      activePresetHandle: unknown;
      persistedPresets: Thermostat.Preset[];
    };
    expect(state.presetTypes.length).toBe(6);
    expect(state.numberOfPresets).toBe(10);
    expect(state.activePresetHandle).toBeNull();
    const presets = state.persistedPresets;
    expect(presets.length).toBe(5);
    for (const preset of presets) {
      expect(preset.builtIn).toBe(true);
      expect(preset.presetHandle).toBeInstanceOf(Uint8Array);
      expect((preset.presetHandle as Uint8Array)?.length).toBe(1);
      expect(preset.heatingSetpoint).toBeDefined();
      expect(preset.coolingSetpoint).toBeUndefined();
      expect(preset.heatingSetpoint).toBeGreaterThanOrEqual(700);
      expect(preset.heatingSetpoint).toBeLessThanOrEqual(3500);
    }
  });

  it("seeds 5 builtIn presets for cooling-only device", () => {
    const self = {
      features: { heating: false, cooling: true, presets: true },
      state: {
        minCoolSetpointLimit: 1500,
        maxCoolSetpointLimit: 3200,
      },
    };
    thermostatPreInitialize(
      self as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const presets = (
      self.state as unknown as { persistedPresets: Thermostat.Preset[] }
    ).persistedPresets;
    expect(presets.length).toBe(5);
    for (const preset of presets) {
      expect(preset.builtIn).toBe(true);
      expect(preset.heatingSetpoint).toBeUndefined();
      expect(preset.coolingSetpoint).toBeDefined();
      expect(preset.coolingSetpoint).toBeGreaterThanOrEqual(1500);
      expect(preset.coolingSetpoint).toBeLessThanOrEqual(3200);
    }
  });

  it("seeds 5 standard defaults on first boot without clamping to raw limits", () => {
    const self = {
      features: { heating: true, cooling: true, presets: true },
      state: {
        minHeatSetpointLimit: 4500, // Raw Fahrenheit limits before update converts them
        maxHeatSetpointLimit: 9000,
        minCoolSetpointLimit: 4500,
        maxCoolSetpointLimit: 9000,
      },
    };
    thermostatPreInitialize(
      self as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const presets = (
      self.state as unknown as { persistedPresets: Thermostat.Preset[] }
    ).persistedPresets;
    expect(presets[0].heatingSetpoint).toBe(2000);
    expect(presets[0].coolingSetpoint).toBe(2333);
    expect(presets[3].heatingSetpoint).toBe(1800);
    expect(presets[3].coolingSetpoint).toBe(2500);
    expect(presets[4].heatingSetpoint).toBe(1000);
    expect(presets[4].coolingSetpoint).toBe(2900);
  });

  it("preserves loaded persistedPresets across consecutive unavailable °F restarts and clamps narrow refrigerator limits in update()", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const fBootSelf = {
      features: { heating: true, cooling: true, presets: true },
      state: {
        minHeatSetpointLimit: 4500,
        maxHeatSetpointLimit: 9500,
        minCoolSetpointLimit: 4500,
        maxCoolSetpointLimit: 9500,
        persistedPresets: [
          {
            presetScenario: Thermostat.PresetScenario.Occupied,
            heatingSetpoint: 2000,
            coolingSetpoint: 2333,
            builtIn: true,
            presetHandle: handle,
          },
        ],
      },
    };
    thermostatPreInitialize(
      fBootSelf as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const fPresets = (
      fBootSelf.state as unknown as { persistedPresets: Thermostat.Preset[] }
    ).persistedPresets;
    expect(fPresets[0].heatingSetpoint).toBe(2000);
    expect(fPresets[0].coolingSetpoint).toBe(2333);

    // Narrow/negative refrigerator bounds are clamped once update() runs with isAvailable=true
    const actions: HomeAssistantAction[] = [];
    const fridgeHa = {
      entity_id: "climate.fridge",
      state: "cool",
      attributes: {
        hvac_modes: ["off", "heat", "cool"],
        temperature: -18,
        current_temperature: -18,
        min_temp: -22,
        max_temp: -14,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const fridgeMock = createClimateMock({
      endpointId: "fridge-ep",
      entityId: "climate.fridge",
      haState: fridgeHa,
      actions,
      activePresetHandle: null,
      heatingSetpoint: 2000,
      coolingSetpoint: 2400,
    });
    fridgeMock.update({
      entity_id: "climate.fridge",
      state: fridgeHa,
    } as unknown as HomeAssistantEntityInformation);
    expect(fridgeMock.state.persistedPresets[0].heatingSetpoint).toBe(-1400);
    expect(fridgeMock.state.persistedPresets[0].coolingSetpoint).toBe(-1400);
  });

  it("repairs loaded persistedPresets by stripping inactive direction without clamping limits before update()", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const self = {
      features: { heating: true, cooling: false, presets: true },
      state: {
        minHeatSetpointLimit: 1800,
        maxHeatSetpointLimit: 2200,
        persistedPresets: [
          {
            presetScenario: Thermostat.PresetScenario.Occupied,
            heatingSetpoint: 1500, // limit clamping is deferred until available update()
            coolingSetpoint: 2600, // cooling not enabled on this device!
            builtIn: true,
            presetHandle: handle,
          },
        ],
      },
    };
    thermostatPreInitialize(
      self as unknown as Parameters<typeof thermostatPreInitialize>[0],
    );
    const presets = (
      self.state as unknown as { persistedPresets: Thermostat.Preset[] }
    ).persistedPresets;
    expect(presets[0].heatingSetpoint).toBe(1500);
    expect(presets[0].coolingSetpoint).toBeUndefined();
    expect(presets[0].builtIn).toBe(true);
    expect(presets[0].presetHandle).toEqual(handle);
  });
});

describe("ThermostatServerBase.setActivePresetRequest", () => {
  it("activates Occupied preset in Mode A and dispatches setTemperature", () => {
    const actions: unknown[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const mockSelf = {
      features: { heating: true, cooling: true, autoMode: true, presets: true },
      state: {
        config: {
          supportsTemperatureRange: () => false,
          setTargetTemperature: (t: { value: number }) => ({
            action: "climate.set_temperature",
            data: { temperature: t.value },
          }),
        },
        occupiedHeatingSetpoint: 1800,
        occupiedCoolingSetpoint: 2200,
        minHeatSetpointLimit: 0,
        maxHeatSetpointLimit: 5000,
        minCoolSetpointLimit: 0,
        maxCoolSetpointLimit: 5000,
        persistedPresets: [
          {
            presetHandle: handle,
            presetScenario: Thermostat.PresetScenario.Occupied,
            heatingSetpoint: 2000,
            coolingSetpoint: 2400,
            builtIn: true,
          },
        ],
        activePresetHandle: null as Uint8Array | null,
        appleAttr0009: null as Uint8Array | null,
        appleAttr000B: 999 as number | null,
        systemMode: 4,
      },
      agent: {
        get: () => ({
          entityId: "climate.test",
          entity: { state: { state: "heat" } },
          callAction: (a: unknown) => actions.push(a),
        }),
        asLocalActor: (fn: () => void) => fn(),
      },
      handleSetActivePresetRequest: ({
        presetHandle,
      }: {
        presetHandle: Uint8Array | null;
      }) => {
        mockSelf.state.activePresetHandle = presetHandle;
        return mockSelf.state.persistedPresets[0];
      },
      setTemperature: (low: { value: number }, high: { value: number }) => {
        actions.push({
          action: "setTemperature",
          low: low.value,
          high: high.value,
        });
      },
    };

    ThermostatServerBase.prototype.setActivePresetRequest.call(
      mockSelf as unknown as ThermostatServerBase,
      { presetHandle: handle },
    );
    expect(mockSelf.state.activePresetHandle).toEqual(handle);
    expect(mockSelf.state.appleAttr0009).toEqual(handle);
    expect(mockSelf.state.appleAttr000B).toBeNull();
    expect(mockSelf.state.occupiedHeatingSetpoint).toBe(2000);
    expect(mockSelf.state.occupiedCoolingSetpoint).toBe(2400);
    expect(actions).toEqual([{ action: "setTemperature", low: 20, high: 24 }]);
  });

  it("sends coolTemp in Cool mode on dual-feature thermostat", () => {
    const actions: {
      mode: Thermostat.SetpointRaiseLowerMode;
      low: number;
      high: number;
    }[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Vacation);
    const mockSelf = {
      features: {
        heating: true,
        cooling: true,
        autoMode: false,
        presets: true,
      },
      state: {
        config: {
          supportsTemperatureRange: () => false,
          setTargetTemperature: () => ({ action: "climate.set_temperature" }),
        },
        occupiedHeatingSetpoint: 1400,
        occupiedCoolingSetpoint: 2900,
        minHeatSetpointLimit: 1000,
        maxHeatSetpointLimit: 3500,
        minCoolSetpointLimit: 1000,
        maxCoolSetpointLimit: 3500,
        persistedPresets: [
          {
            presetHandle: handle,
            presetScenario: Thermostat.PresetScenario.Vacation,
            heatingSetpoint: 1400,
            coolingSetpoint: 2900,
            builtIn: true,
          },
        ],
        activePresetHandle: null as Uint8Array | null,
        systemMode: 3, // Cool mode
      },
      agent: {
        get: () => ({
          entityId: "climate.test",
          entity: { state: { state: "cool" } },
          callAction: () => {},
        }),
        asLocalActor: (fn: () => void) => fn(),
      },
      handleSetActivePresetRequest: ({
        presetHandle,
      }: {
        presetHandle: Uint8Array | null;
      }) => {
        mockSelf.state.activePresetHandle = presetHandle;
        return mockSelf.state.persistedPresets[0];
      },
      setTemperature: (
        low: { value: number },
        high: { value: number },
        mode: Thermostat.SetpointRaiseLowerMode,
      ) => {
        actions.push({ mode, low: low.value, high: high.value });
      },
    };

    ThermostatServerBase.prototype.setActivePresetRequest.call(
      mockSelf as unknown as ThermostatServerBase,
      { presetHandle: handle },
    );
    expect(actions).toEqual([
      { mode: Thermostat.SetpointRaiseLowerMode.Cool, low: 14, high: 29 },
    ]);
  });

  it("orders cooling write first when raising heat above old cool in autoMode", () => {
    const writeOrder: string[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const mockSelf = {
      features: { heating: true, cooling: true, autoMode: true, presets: true },
      state: {
        config: {
          supportsTemperatureRange: () => false,
        },
        _heat: 1800,
        _cool: 2100, // old cool is 2100; new heat is 2200 (> old cool)
        get occupiedHeatingSetpoint() {
          return this._heat;
        },
        set occupiedHeatingSetpoint(v: number) {
          writeOrder.push("heat");
          this._heat = v;
        },
        get occupiedCoolingSetpoint() {
          return this._cool;
        },
        set occupiedCoolingSetpoint(v: number) {
          writeOrder.push("cool");
          this._cool = v;
        },
        minHeatSetpointLimit: 0,
        maxHeatSetpointLimit: 5000,
        minCoolSetpointLimit: 0,
        maxCoolSetpointLimit: 5000,
        persistedPresets: [
          {
            presetHandle: handle,
            presetScenario: Thermostat.PresetScenario.Occupied,
            heatingSetpoint: 2200,
            coolingSetpoint: 2500,
            builtIn: true,
          },
        ],
        activePresetHandle: null as Uint8Array | null,
        systemMode: 4,
      },
      agent: {
        get: () => ({
          entityId: "climate.test",
          entity: { state: { state: "auto" } },
          callAction: () => {},
        }),
        asLocalActor: (fn: () => void) => fn(),
      },
      handleSetActivePresetRequest: ({
        presetHandle,
      }: {
        presetHandle: Uint8Array | null;
      }) => {
        mockSelf.state.activePresetHandle = presetHandle;
        return mockSelf.state.persistedPresets[0];
      },
      setTemperature: () => {},
    };

    ThermostatServerBase.prototype.setActivePresetRequest.call(
      mockSelf as unknown as ThermostatServerBase,
      { presetHandle: handle },
    );
    expect(writeOrder).toEqual(["cool", "heat"]);
  });

  it("picks Cool resume mode when thermostat is Off and room temp is hotter than preset cool bound", () => {
    const actions: unknown[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const mockSelf = {
      features: { heating: true, cooling: true, autoMode: true, presets: true },
      state: {
        config: {
          supportsTemperatureRange: () => false,
          setSystemMode: (mode: Thermostat.SystemMode) => ({
            action: "climate.set_hvac_mode",
            data: { hvac_mode: mode === 3 ? "cool" : "heat" },
          }),
          setTargetTemperature: (t: { value: number }) => ({
            action: "climate.set_temperature",
            data: { temperature: t.value },
          }),
        },
        localTemperature: 2800,
        occupiedHeatingSetpoint: 2000,
        occupiedCoolingSetpoint: 2300,
        minHeatSetpointLimit: 700,
        maxHeatSetpointLimit: 3500,
        minCoolSetpointLimit: 700,
        maxCoolSetpointLimit: 3500,
        persistedPresets: [
          {
            presetHandle: handle,
            presetScenario: Thermostat.PresetScenario.Occupied,
            heatingSetpoint: 2000,
            coolingSetpoint: 2300,
            builtIn: true,
          },
        ],
        activePresetHandle: null as Uint8Array | null,
        systemMode: Thermostat.SystemMode.Off,
      },
      internal: {
        controlSequenceOfOperation:
          Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
      },
      agent: {
        get: () => ({
          entityId: "climate.hot_room",
          entity: { state: { state: "off" } },
          callAction: (a: unknown) => actions.push(a),
        }),
        asLocalActor: (fn: () => void) => fn(),
      },
      handleSetActivePresetRequest: ({
        presetHandle,
      }: {
        presetHandle: Uint8Array | null;
      }) => {
        mockSelf.state.activePresetHandle = presetHandle;
        return mockSelf.state.persistedPresets[0];
      },
      resumeModeFor: (
        ThermostatServerBase.prototype as unknown as {
          resumeModeFor: () => Thermostat.SystemMode;
        }
      ).resumeModeFor,
      autoResumeFromOff: (
        ThermostatServerBase.prototype as unknown as {
          autoResumeFromOff: () => Thermostat.SystemMode;
        }
      ).autoResumeFromOff,
      setTemperature: (
        ThermostatServerBase.prototype as unknown as {
          setTemperature: () => void;
        }
      ).setTemperature,
    };

    ThermostatServerBase.prototype.setActivePresetRequest.call(
      mockSelf as unknown as ThermostatServerBase,
      { presetHandle: handle },
    );
    expect(mockSelf.state.systemMode).toBe(Thermostat.SystemMode.Cool);
    expect(actions[0]).toEqual({
      action: "climate.set_hvac_mode",
      data: { hvac_mode: "cool" },
    });
  });

  it("clears activePresetHandle, appleAttr0009, and appleAttr000B on setpointRaiseLower", () => {
    const actions: unknown[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const mockSelf = {
      features: {
        heating: true,
        cooling: true,
        autoMode: false,
        presets: true,
      },
      state: {
        config: {
          supportsTemperatureRange: () => false,
          getTargetHeatingTemperature: () => ({
            plus: () => ({ celsius: () => 21 }),
            celsius: () => 20,
          }),
          getTargetCoolingTemperature: () => ({
            plus: () => ({ celsius: () => 24 }),
            celsius: () => 24,
          }),
        },
        activePresetHandle: handle as Uint8Array | null,
        appleAttr0009: handle as Uint8Array | null,
        appleAttr000B: 1795746272 as number | null,
        minHeatSetpointLimit: 700,
        maxHeatSetpointLimit: 3500,
        minCoolSetpointLimit: 700,
        maxCoolSetpointLimit: 3500,
        systemMode: Thermostat.SystemMode.Heat,
      },
      agent: {
        get: () => ({
          entityId: "climate.raise_lower",
          entity: { state: { state: "heat" } },
          assertAvailable: () => {},
        }),
        asLocalActor: (fn: () => void) => fn(),
      },
      clampToLimits: (v: { celsius: () => number }) => v,
      clampSetpoint: (v: number) => v,
      setTemperature: (low: { celsius: () => number }) => {
        actions.push(low.celsius());
      },
    };

    ThermostatServerBase.prototype.setpointRaiseLower.call(
      mockSelf as unknown as ThermostatServerBase,
      { mode: Thermostat.SetpointRaiseLowerMode.Heat, amount: 10 },
    );
    expect(mockSelf.state.activePresetHandle).toBeNull();
    expect(mockSelf.state.appleAttr0009).toBeNull();
    expect(mockSelf.state.appleAttr000B).toBeNull();
    expect(actions).toHaveLength(1);
  });

  it("does not clear preset or open echo window when setpointRaiseLower fails assertAvailable", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.unavailable_raise",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 25,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "unavail-raise-ep",
      entityId: "climate.unavailable_raise",
      haState,
      actions: [],
      activePresetHandle: handle,
      heatingSetpoint: 2000,
    });
    const originalGet = mockSelf.agent.get;
    mockSelf.agent.get = ((cls: unknown) => ({
      ...originalGet(cls),
      assertAvailable: () => {
        throw new Error("Entity unavailable");
      },
    })) as typeof mockSelf.agent.get;

    expect(() =>
      ThermostatServerBase.prototype.setpointRaiseLower.call(
        mockSelf as unknown as ThermostatServerBase,
        { mode: Thermostat.SetpointRaiseLowerMode.Heat, amount: 10 },
      ),
    ).toThrow("Entity unavailable");

    expect(mockSelf.state.activePresetHandle).toEqual(handle);
    expect(mockSelf.state.appleAttr0009).toEqual(handle);
    expect(mockSelf.state.appleAttr000B).toBe(1795746272);

    // Confirm no false 8s echo window was opened when HA subsequently drifts
    mockSelf.agent.get = originalGet;
    mockSelf.update({
      entity_id: "climate.unavailable_raise",
      state: haState,
    } as unknown as HomeAssistantEntityInformation);
    expect(mockSelf.state.activePresetHandle).toBeNull();
  });
});

describe("ThermostatServerBase.persistedPresetsChanged", () => {
  it("ignores offline transactions", () => {
    const actions: unknown[] = [];
    const mockSelf = {
      features: { heating: true, cooling: true, presets: true },
      state: { config: {} },
      agent: {
        asLocalActor: () => actions.push("asLocalActor"),
      },
    };
    (
      ThermostatServerBase.prototype as unknown as MockThermostatBehavior
    ).persistedPresetsChanged.call(mockSelf, [], [], null);
    expect(actions).toEqual([]);
  });

  it("applies setpoints and dispatches setTemperature when active preset is edited remotely", () => {
    const actions: unknown[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const oldPresets = [
      {
        presetHandle: handle,
        presetScenario: Thermostat.PresetScenario.Occupied,
        heatingSetpoint: 2000,
        coolingSetpoint: 2400,
        builtIn: true,
      },
    ];
    const newPresets = [
      {
        presetHandle: handle,
        presetScenario: Thermostat.PresetScenario.Occupied,
        heatingSetpoint: 2100,
        coolingSetpoint: 2400,
        builtIn: true,
      },
    ];

    const mockSelf = {
      features: { heating: true, cooling: true, presets: true },
      state: {
        config: {},
        activePresetHandle: handle,
        occupiedHeatingSetpoint: 2000,
        occupiedCoolingSetpoint: 2400,
      },
      agent: {
        get: () => ({ entityId: "climate.test", callAction: () => {} }),
        asLocalActor: (fn: () => void) => fn(),
      },
      setTemperature: (low: { value: number }, high: { value: number }) => {
        actions.push({
          action: "setTemperature",
          low: low.value,
          high: high.value,
        });
      },
    };

    const onlineContext = {
      subject: 1n,
      session: { subject: 1n },
    } as unknown as ActionContext;
    (
      ThermostatServerBase.prototype as unknown as MockThermostatBehavior
    ).persistedPresetsChanged.call(
      mockSelf,
      newPresets,
      oldPresets,
      onlineContext,
    );

    expect(mockSelf.state.occupiedHeatingSetpoint).toBe(2100);
    expect(actions).toEqual([{ action: "setTemperature", low: 21, high: 24 }]);
  });

  it("latches inactive bound edits silently in single-setpoint mode and dispatches active bound edits", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.inactive_bound",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
      last_changed: "2026-11-26T00:00:00Z",
      last_updated: "2026-11-26T00:00:00Z",
      context: { id: "1" },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "inactive-bound-ep",
      entityId: "climate.inactive_bound",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2000,
      coolingSetpoint: 2333,
      systemMode: Thermostat.SystemMode.Heat,
    });

    const onlineContext = {
      subject: 1n,
      session: { subject: 1n },
    } as unknown as ActionContext;
    const initialPresets = mockSelf.state.persistedPresets;
    const coolEdited = [{ ...initialPresets[0], coolingSetpoint: 2500 }];
    const heatEdited = [
      { ...initialPresets[0], heatingSetpoint: 2100, coolingSetpoint: 2500 },
    ];

    mockSelf.persistedPresetsChanged(coolEdited, initialPresets, onlineContext);
    expect(mockSelf.state.occupiedCoolingSetpoint).toBe(2500);
    expect(actions).toEqual([]);

    mockSelf.persistedPresetsChanged(heatEdited, coolEdited, onlineContext);
    expect(mockSelf.state.occupiedHeatingSetpoint).toBe(2100);
    expect(actions).toEqual([
      { action: "climate.set_temperature", data: { temperature: 21 } },
    ]);
  });
});

function createClimateMock(opts: {
  endpointId?: string;
  entityId: string;
  haState: HomeAssistantEntityState<ClimateDeviceAttributes>;
  actions: HomeAssistantAction[];
  activePresetHandle: Uint8Array | null;
  heatingSetpoint?: number;
  coolingSetpoint?: number;
  systemMode?: Thermostat.SystemMode;
}) {
  const behavior = ClimateThermostatServer(
    {},
    { heating: true, cooling: true, autoMode: true },
    true,
  ) as unknown as { defaults: { config: ThermostatServerConfig } };
  const config = behavior.defaults.config;
  const proto = ThermostatServerBase.prototype as unknown as {
    getSystemMode: (e: HomeAssistantEntityInformation) => Thermostat.SystemMode;
    clampSystemMode: (v: Thermostat.SystemMode) => Thermostat.SystemMode;
    clampSetpoint: (
      v: number | undefined,
      min: number | undefined,
      max: number | undefined,
      t: "heat" | "cool",
    ) => number;
    clampControlSequence: (
      v: Thermostat.ControlSequenceOfOperation,
    ) => Thermostat.ControlSequenceOfOperation;
    getRunningState: () => Record<string, boolean>;
    trackNudge: () => void;
    restoreIntendedPreset: (c?: ActionContext) => void;
    setpointChanging: (
      kind: "heat" | "cool",
      value: number,
      oldValue: number,
      context?: ActionContext,
    ) => void;
    reconcilePersistedPresets: () => void;
    reconcileActivePresetOnUpdate: () => void;
    setTemperature: () => void;
    update: (e: HomeAssistantEntityInformation) => void;
    persistedPresetsChanged: (
      n: Thermostat.Preset[],
      o: Thermostat.Preset[],
      c?: ActionContext,
    ) => void;
  };
  const haBehavior = {
    entityId: opts.entityId,
    isAvailable: true,
    entity: { entity_id: opts.entityId, state: opts.haState },
    state: { mapping: {} },
    callAction: (a: HomeAssistantAction) => opts.actions.push(a),
  };
  const haConfig = { unitSystem: { temperature: "°C" } };
  const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
  const mockSelf = {
    endpoint: opts.endpointId ? { id: opts.endpointId } : undefined,
    features: { heating: true, cooling: true, autoMode: true, presets: true },
    state: {
      config,
      activePresetHandle: opts.activePresetHandle,
      appleAttr0009: opts.activePresetHandle,
      appleAttr000B: opts.activePresetHandle ? 1795746272 : null,
      persistedPresets: [
        {
          presetHandle: opts.activePresetHandle ?? handle,
          presetScenario: Thermostat.PresetScenario.Occupied,
          heatingSetpoint: opts.heatingSetpoint ?? 2000,
          coolingSetpoint: opts.coolingSetpoint ?? 2400,
          builtIn: true,
        },
      ],
      occupiedHeatingSetpoint: opts.heatingSetpoint ?? 2000,
      occupiedCoolingSetpoint: opts.coolingSetpoint ?? 2400,
      minHeatSetpointLimit: 700,
      maxHeatSetpointLimit: 3500,
      minCoolSetpointLimit: 700,
      maxCoolSetpointLimit: 3500,
      systemMode: opts.systemMode ?? Thermostat.SystemMode.Heat,
    },
    agent: {
      get: (cls: unknown) =>
        cls === HomeAssistantEntityBehavior ? haBehavior : undefined,
      asLocalActor: (fn: () => void) => fn(),
      env: {
        get: (cls: unknown) =>
          cls === HomeAssistantConfig ? haConfig : undefined,
      },
    },
    internal: {},
    getSystemMode: proto.getSystemMode,
    clampSystemMode: proto.clampSystemMode,
    clampSetpoint: proto.clampSetpoint,
    clampControlSequence: proto.clampControlSequence,
    getRunningState: proto.getRunningState,
    trackNudge: proto.trackNudge,
    restoreIntendedPreset: proto.restoreIntendedPreset,
    setpointChanging: proto.setpointChanging,
    reconcilePersistedPresets: proto.reconcilePersistedPresets,
    reconcileActivePresetOnUpdate: proto.reconcileActivePresetOnUpdate,
    setTemperature: proto.setTemperature,
    update(entity: HomeAssistantEntityInformation) {
      proto.update.call(this, entity);
    },
    persistedPresetsChanged(
      n: Thermostat.Preset[],
      o: Thermostat.Preset[],
      c?: ActionContext,
    ) {
      proto.persistedPresetsChanged.call(this, n, o, c);
    },
  };
  return mockSelf;
}

describe("ThermostatServerBase.update preset handling", () => {
  it("preserves activePresetHandle when HA setpoint matches active preset within rounding tolerance", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.test",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat"],
        temperature: 20.28,
        current_temperature: 20,
        min_temp: 10,
        max_temp: 30,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "tol-ep",
      entityId: "climate.test",
      haState,
      actions: [],
      activePresetHandle: handle,
      heatingSetpoint: 2000,
    });
    mockSelf.features.cooling = false;
    mockSelf.features.autoMode = false;

    mockSelf.update({
      entity_id: "climate.test",
      state: haState,
    } as unknown as HomeAssistantEntityInformation);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);
  });

  it("clears activePresetHandle, appleAttr0009, and appleAttr000B when HA setpoint diverges outside tolerance", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.diverge",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 25,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "diverge-ep",
      entityId: "climate.diverge",
      haState,
      actions: [],
      activePresetHandle: handle,
      heatingSetpoint: 2000,
    });

    mockSelf.update({
      entity_id: "climate.diverge",
      state: haState,
    } as unknown as HomeAssistantEntityInformation);
    expect(mockSelf.state.activePresetHandle).toBeNull();
    expect(mockSelf.state.appleAttr0009).toBeNull();
    expect(mockSelf.state.appleAttr000B).toBeNull();
  });

  it("applies latched cool and dual-range setpoints on HVAC mode switches while a preset is active", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.mode_switch",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 20.5,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "mode-switch-ep",
      entityId: "climate.mode_switch",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2050,
      coolingSetpoint: 2300,
    });
    const entityInfo = {
      entity_id: "climate.mode_switch",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    mockSelf.update(entityInfo);
    expect(actions).toEqual([]);

    haState.state = "cool" as ClimateDeviceAttributes["hvac_modes"][number];
    haState.attributes.temperature = 25;
    mockSelf.update(entityInfo);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);
    expect(actions.at(-1)).toEqual({
      action: "climate.set_temperature",
      data: { temperature: 23 },
    });

    haState.state =
      "heat_cool" as ClimateDeviceAttributes["hvac_modes"][number];
    haState.attributes.target_temp_low = 19;
    haState.attributes.target_temp_high = 26;
    mockSelf.update(entityInfo);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);
    expect(actions.at(-1)).toEqual({
      action: "climate.set_temperature",
      data: { target_temp_low: 20.5, target_temp_high: 23 },
    });
  });

  it("does not re-apply latched setpoints when single-setpoint auto mode flips Heat <-> Cool dynamically", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.single_auto",
      state: "auto",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "auto"],
        hvac_action: "heating",
        temperature: 20.5,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "single-auto-ep",
      entityId: "climate.single_auto",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2050,
      coolingSetpoint: 2050,
    });
    mockSelf.features.autoMode = false;
    const entityInfo = {
      entity_id: "climate.single_auto",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    mockSelf.update(entityInfo);
    haState.attributes.hvac_action =
      "cooling" as ClimateDeviceAttributes["hvac_action"];
    mockSelf.update(entityInfo);

    expect(actions).toEqual([]);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);
  });

  it("isolates runtime state across two endpoints sharing the same climate entity", () => {
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.shared_bedroom",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 21,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;

    const actions1: HomeAssistantAction[] = [];
    const actions2: HomeAssistantAction[] = [];
    const bridge1 = createClimateMock({
      endpointId: "bridge1-ep",
      entityId: "climate.shared_bedroom",
      haState,
      actions: actions1,
      activePresetHandle: null,
      heatingSetpoint: 2111,
      coolingSetpoint: 2333,
    });
    const bridge2 = createClimateMock({
      endpointId: "bridge2-ep",
      entityId: "climate.shared_bedroom",
      haState,
      actions: actions2,
      activePresetHandle: handle,
      heatingSetpoint: 2111,
      coolingSetpoint: 2333,
    });
    const entityInfo = {
      entity_id: "climate.shared_bedroom",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    bridge1.update(entityInfo);
    bridge2.update(entityInfo);

    haState.state = "cool" as ClimateDeviceAttributes["hvac_modes"][number];
    haState.attributes.temperature = 21;
    bridge1.update(entityInfo);
    bridge2.update(entityInfo);

    expect(bridge1.state.activePresetHandle).toBeNull();
    expect(bridge2.state.activePresetHandle).toEqual(handle);
    expect(actions1).toEqual([]);
    expect(actions2.at(-1)).toEqual({
      action: "climate.set_temperature",
      data: { temperature: 23.3 },
    });
  });

  it("does not overwrite manual HA turn-on from Off with a stale latched preset", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.off_manual_on",
      state: "off",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        temperature: 20,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "off-manual-on-ep",
      entityId: "climate.off_manual_on",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2000,
      coolingSetpoint: 2400,
      systemMode: Thermostat.SystemMode.Off,
    });
    const entityInfo = {
      entity_id: "climate.off_manual_on",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    // Seed lastObservedSystemMode = Off
    mockSelf.update(entityInfo);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);

    // User turns thermostat ON in HA with a manual setpoint (25°C)
    haState.state = "heat" as ClimateDeviceAttributes["hvac_modes"][number];
    haState.attributes.temperature = 25;
    mockSelf.update(entityInfo);

    expect(actions).toEqual([]);
    expect(mockSelf.state.activePresetHandle).toBeNull();
    expect(mockSelf.state.appleAttr0009).toBeNull();
    expect(mockSelf.state.appleAttr000B).toBeNull();
  });

  it("preserves default persistedPresets when a Fahrenheit thermostat boots unavailable", () => {
    const actions: HomeAssistantAction[] = [];
    const haState = {
      entity_id: "climate.f_boot",
      state: "unavailable",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "heat_cool"],
        supported_features: 3,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "f-boot-ep",
      entityId: "climate.f_boot",
      haState,
      actions,
      activePresetHandle: null,
      heatingSetpoint: 2000,
      coolingSetpoint: 2333,
    });
    // Simulate ClimateDevice seeding unconverted raw °F×100 limits before HomeAssistantConfig converts units
    mockSelf.state.minHeatSetpointLimit = 4500;
    mockSelf.state.maxHeatSetpointLimit = 9500;
    mockSelf.state.minCoolSetpointLimit = 4500;
    mockSelf.state.maxCoolSetpointLimit = 9500;
    const haBehavior = mockSelf.agent.get(HomeAssistantEntityBehavior) as {
      isAvailable: boolean;
    };
    haBehavior.isAvailable = false;

    const entityInfo = {
      entity_id: "climate.f_boot",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    mockSelf.update(entityInfo);
    expect(mockSelf.state.persistedPresets[0].heatingSetpoint).toBe(2000);
    expect(mockSelf.state.persistedPresets[0].coolingSetpoint).toBe(2333);

    // Once HA reports available state with converted °C bounds, presets stay intact
    haBehavior.isAvailable = true;
    haState.state = "heat" as ClimateDeviceAttributes["hvac_modes"][number];
    haState.attributes.temperature = 20;
    haState.attributes.current_temperature = 20;
    haState.attributes.min_temp = 7.2;
    haState.attributes.max_temp = 35;
    mockSelf.update(entityInfo);
    expect(mockSelf.state.persistedPresets[0].heatingSetpoint).toBe(2000);
    expect(mockSelf.state.persistedPresets[0].coolingSetpoint).toBe(2333);
  });

  it("does not fire mode-switch setTemperature on heat_cool-only hvac_action flips or Dry/FanOnly transitions", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.zone_hc",
      state: "heat_cool",
      attributes: {
        hvac_modes: ["off", "heat_cool"],
        hvac_action: "heating",
        target_temp_low: 20,
        target_temp_high: 23.3,
        current_temperature: 20.5,
        min_temp: 7,
        max_temp: 35,
        supported_features: 2,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "zone-hc-ep",
      entityId: "climate.zone_hc",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2000,
      coolingSetpoint: 2333,
    });
    mockSelf.features.autoMode = false;
    const entityInfo = {
      entity_id: "climate.zone_hc",
      state: haState,
    } as unknown as HomeAssistantEntityInformation;

    mockSelf.update(entityInfo);
    haState.attributes.hvac_action =
      "cooling" as ClimateDeviceAttributes["hvac_action"];
    mockSelf.update(entityInfo);
    expect(actions).toEqual([]);
    expect(mockSelf.state.activePresetHandle).toEqual(handle);

    // Also verify Heat -> Dry transition does not push Cool preset setpoint
    const heatDryState = {
      entity_id: "climate.heat_dry",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "dry"],
        temperature: 20,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const dryActions: HomeAssistantAction[] = [];
    const dryMock = createClimateMock({
      endpointId: "heat-dry-ep",
      entityId: "climate.heat_dry",
      haState: heatDryState,
      actions: dryActions,
      activePresetHandle: handle,
      heatingSetpoint: 2000,
      coolingSetpoint: 2333,
      systemMode: Thermostat.SystemMode.Heat,
    });
    const dryInfo = {
      entity_id: "climate.heat_dry",
      state: heatDryState,
    } as unknown as HomeAssistantEntityInformation;
    dryMock.update(dryInfo);
    heatDryState.state = "dry" as ClimateDeviceAttributes["hvac_modes"][number];
    dryMock.update(dryInfo);
    expect(dryActions).toEqual([]);
  });

  it("clears appleAttr0009/000B when Matter.js clears activePresetHandle on a cross-mode setpoint write", () => {
    const actions: HomeAssistantAction[] = [];
    const haState = {
      entity_id: "climate.cross_mode",
      state: "heat",
      attributes: {
        hvac_modes: ["off", "heat", "cool"],
        temperature: 20,
        current_temperature: 20,
        min_temp: 7,
        max_temp: 35,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    // Simulate Matter.js preCommit having already set activePresetHandle = null on cross-mode write
    const mockSelf = createClimateMock({
      endpointId: "cross-mode-ep",
      entityId: "climate.cross_mode",
      haState,
      actions,
      activePresetHandle: null,
      heatingSetpoint: 2000,
      coolingSetpoint: 2333,
      systemMode: Thermostat.SystemMode.Heat,
    });
    const staleHandle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    mockSelf.state.appleAttr0009 = staleHandle;
    mockSelf.state.appleAttr000B = 1795746272;

    const onlineContext = {
      subject: 1n,
      session: { subject: 1n },
    } as unknown as ActionContext;
    (
      ThermostatServerBase.prototype as unknown as {
        coolingSetpointChanging: (
          value: number,
          oldValue: number,
          context?: ActionContext,
        ) => void;
      }
    ).coolingSetpointChanging.call(mockSelf, 2500, 2333, onlineContext);

    expect(actions).toEqual([]);
    expect(mockSelf.state.appleAttr0009).toBeNull();
    expect(mockSelf.state.appleAttr000B).toBeNull();
  });

  it("ignores heatingSetpoint-only preset edits in Dry mode on heat+cool devices", () => {
    const actions: HomeAssistantAction[] = [];
    const handle = createPresetHandle(Thermostat.PresetScenario.Occupied);
    const haState = {
      entity_id: "climate.dry_edit",
      state: "dry",
      attributes: {
        hvac_modes: ["off", "heat", "cool", "dry"],
        temperature: 24,
        current_temperature: 23,
        min_temp: 7,
        max_temp: 35,
        supported_features: 1,
      },
    } as unknown as HomeAssistantEntityState<ClimateDeviceAttributes>;
    const mockSelf = createClimateMock({
      endpointId: "dry-edit-ep",
      entityId: "climate.dry_edit",
      haState,
      actions,
      activePresetHandle: handle,
      heatingSetpoint: 2000,
      coolingSetpoint: 2400,
      systemMode: Thermostat.SystemMode.Dry,
    });
    const oldPresets = mockSelf.state.persistedPresets;
    const newPresets = [
      {
        ...oldPresets[0],
        heatingSetpoint: 2150,
      },
    ];
    mockSelf.state.persistedPresets = newPresets;

    const onlineContext = {
      subject: 1n,
      session: { subject: 1n },
    } as unknown as ActionContext;
    (
      ThermostatServerBase.prototype as unknown as MockThermostatBehavior
    ).persistedPresetsChanged.call(
      mockSelf,
      newPresets,
      oldPresets,
      onlineContext,
    );

    expect(actions).toEqual([]);
  });
});
