import {
  type ClimateDeviceAttributes,
  ClimateDeviceFeature,
  ClimateHvacMode,
} from "@home-assistant-matter-hub/common";
import type { ClusterBehavior, EndpointType } from "@matter/main";
import {
  RoomAirConditionerDevice,
  ThermostatDevice,
} from "@matter/main/devices";
import { InvalidDeviceError } from "../../../../utils/errors/invalid-device-error.js";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import { ThermostatUiConfigServer } from "../../../behaviors/thermostat-ui-config-server.js";
import {
  ClimateFanControlServer,
  climateSupportsAutoFanMode,
  swingModesToRockSupport,
} from "./behaviors/climate-fan-control-server.js";
import { ClimateHumidityMeasurementServer } from "./behaviors/climate-humidity-measurement-server.js";
import { ClimateOnOffServer } from "./behaviors/climate-on-off-server.js";
import { ClimateThermostatServer } from "./behaviors/climate-thermostat-server.js";

/**
 * Initial thermostat state extracted from Home Assistant entity.
 * Used to provide valid defaults BEFORE Matter.js validation runs.
 */
interface InitialThermostatState {
  localTemperature?: number;
  occupiedHeatingSetpoint?: number;
  occupiedCoolingSetpoint?: number;
  minHeatSetpointLimit?: number;
  maxHeatSetpointLimit?: number;
  minCoolSetpointLimit?: number;
  maxCoolSetpointLimit?: number;
}

const ClimateDeviceType = (
  supportsOnOff: boolean,
  supportsHumidity: boolean,
  supportsFanMode: boolean,
  supportsAutoFanMode: boolean,
  rockSupport:
    | { rockLeftRight?: boolean; rockUpDown?: boolean; rockRound?: boolean }
    | undefined,
  hasBattery: boolean,
  features: { heating: boolean; cooling: boolean; autoMode?: boolean },
  initialState: InitialThermostatState = {},
  includeBasicInformation = true,
) => {
  const additionalClusters: ClusterBehavior.Type[] = [];

  if (supportsOnOff) {
    additionalClusters.push(ClimateOnOffServer);
  }
  if (supportsHumidity) {
    additionalClusters.push(ClimateHumidityMeasurementServer);
  }
  if (hasBattery) {
    additionalClusters.push(DefaultPowerSourceServer);
  }

  // Use feature-specific thermostat server so controllers like Alexa
  // see only the features the device actually supports (#136).
  // Pass initialState directly so the behavior class has correct limits
  // from the start, critical for negative temperatures (refrigerators).
  const thermostatServer = ClimateThermostatServer(initialState, features);

  // BasicInformationServer is dropped when this type is used as a composed
  // sub-endpoint; the BridgedNode parent carries the basic info instead, the
  // same way the composed sensor and air purifier sub-endpoints are built.
  const basicInfo: ClusterBehavior.Type[] = includeBasicInformation
    ? [BasicInformationServer]
    : [];

  if (supportsFanMode) {
    return RoomAirConditionerDevice.with(
      IdentifyServer,
      HomeAssistantEntityBehavior,
      thermostatServer,
      ThermostatUiConfigServer,
      ClimateFanControlServer(rockSupport, supportsAutoFanMode),
      ...additionalClusters,
      ...basicInfo,
    );
  }

  return ThermostatDevice.with(
    IdentifyServer,
    HomeAssistantEntityBehavior,
    thermostatServer,
    ThermostatUiConfigServer,
    ...additionalClusters,
    ...basicInfo,
  );
};

const coolingModes: ClimateHvacMode[] = [
  ClimateHvacMode.heat_cool,
  ClimateHvacMode.cool,
];
const heatingModes: ClimateHvacMode[] = [
  ClimateHvacMode.heat_cool,
  ClimateHvacMode.heat,
];
// Auto-only thermostats (no explicit heat/cool) should be treated as heating
const autoOnlyMode: ClimateHvacMode[] = [ClimateHvacMode.auto];
// Ventilation-only devices (e.g. Ambientika CMV) that only support fan_only/dry
const ventilationOnlyModes: ClimateHvacMode[] = [
  ClimateHvacMode.fan_only,
  ClimateHvacMode.dry,
];

/**
 * Convert HA temperature to Matter temperature (0.01°C units).
 * Returns undefined if value is null/undefined/invalid.
 */
function toMatterTemp(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null) return undefined;
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return undefined;
  return Math.round(num * 100);
}

export function ClimateDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
  includeBasicInformation = true,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as ClimateDeviceAttributes & {
    battery?: number;
    battery_level?: number;
  };
  const supportedFeatures = attributes.supported_features ?? 0;
  const hasBatteryAttr =
    attributes.battery_level != null || attributes.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasBattery = hasBatteryAttr || hasBatteryEntity;

  // heat_cool-only zones (e.g. HVAC zones that follow the main system) get
  // both Heating and Cooling features (without AutoMode). The thermostat
  // server dynamically sets controlSequenceOfOperation to HeatingOnly or
  // CoolingOnly based on hvac_action to reflect the main system's mode (#207).
  const supportsCooling = coolingModes.some((mode) =>
    attributes.hvac_modes.includes(mode),
  );
  const hasExplicitHeating = heatingModes.some((mode) =>
    attributes.hvac_modes.includes(mode),
  );
  // Treat auto-only thermostats (no heat/cool/heat_cool) as heating devices
  // so simple "auto"-only thermostats still map onto a Matter mode.
  const isAutoOnly =
    !hasExplicitHeating &&
    !supportsCooling &&
    autoOnlyMode.some((mode) => attributes.hvac_modes.includes(mode));
  // Treat ventilation-only devices (fan_only/dry, no heat/cool/auto) as
  // heating devices so CMVs like Ambientika (#130) still surface as Matter
  // thermostats. The actual mode control runs through SystemMode.FanOnly/Dry.
  const isVentilationOnly =
    !hasExplicitHeating &&
    !supportsCooling &&
    !isAutoOnly &&
    ventilationOnlyModes.some((mode) => attributes.hvac_modes.includes(mode));
  const supportsHeating = hasExplicitHeating || isAutoOnly || isVentilationOnly;

  // Validate that at least one usable mode is supported
  if (!supportsCooling && !supportsHeating) {
    throw new InvalidDeviceError(
      `Climates have to support at least one of: heat, cool, heat_cool, auto, fan_only, or dry. ` +
        `Found: [${attributes.hvac_modes.join(", ")}]`,
    );
  }

  // Check if current_humidity attribute exists (not just TARGET_HUMIDITY feature)
  // Many devices report humidity without supporting target humidity control
  const supportsHumidity =
    attributes.current_humidity != null ||
    testBit(supportedFeatures, ClimateDeviceFeature.TARGET_HUMIDITY);
  // Per-entity opt-out: skip OnOff so room-level "off" voice commands don't
  // turn the thermostat off alongside the lights.
  const supportsOnOff =
    testBit(supportedFeatures, ClimateDeviceFeature.TURN_ON) &&
    testBit(supportedFeatures, ClimateDeviceFeature.TURN_OFF) &&
    homeAssistantEntity.mapping?.disableClimateOnOff !== true;
  // Per-entity opt-out: skip FanControl + RoomAirConditionerDevice and fall
  // back to ThermostatDevice. Workaround for controllers (e.g. Aqara) that
  // don't recognise device type 0x0072 and drop the endpoint (#318).
  const supportsFanMode =
    testBit(supportedFeatures, ClimateDeviceFeature.FAN_MODE) &&
    homeAssistantEntity.mapping?.disableClimateFanControl !== true;
  const supportsAutoFanMode = climateSupportsAutoFanMode(attributes.fan_modes);
  const supportsVerticalSwing = testBit(
    supportedFeatures,
    ClimateDeviceFeature.SWING_MODE,
  );
  const supportsHorizontalSwing = testBit(
    supportedFeatures,
    ClimateDeviceFeature.SWING_HORIZONTAL_MODE,
  );
  const swingModesRockSupport = swingModesToRockSupport(attributes.swing_modes);
  const rockSupport =
    supportsVerticalSwing ||
    supportsHorizontalSwing ||
    swingModesRockSupport.rockLeftRight ||
    swingModesRockSupport.rockUpDown
      ? {
          rockLeftRight:
            swingModesRockSupport.rockLeftRight ||
            supportsHorizontalSwing ||
            undefined,
          rockUpDown:
            swingModesRockSupport.rockUpDown ||
            supportsVerticalSwing ||
            undefined,
        }
      : undefined;

  // Matter requires min <= max (and absMin <= min <= max <= absMax). HA can
  // report min_temp > max_temp (or mixed units), so order the pair before Matter
  // sees it, otherwise the Thermostat fails to initialize (code 135), the whole
  // endpoint crashes, and Google Home spawns a duplicate device (#375).
  const rawMinLimit = toMatterTemp(attributes.min_temp) ?? 0;
  const rawMaxLimit = toMatterTemp(attributes.max_temp) ?? 5000;
  const minLimit = Math.min(rawMinLimit, rawMaxLimit);
  const maxLimit = Math.max(rawMinLimit, rawMaxLimit);

  // Extract initial thermostat state from HA entity attributes.
  // These values are passed to Matter.js during registration to prevent
  // NaN validation errors (Matter.js validates BEFORE our initialize() runs).
  const initialState: InitialThermostatState = {
    // Pass actual current_temperature for initial state.
    // If unavailable (null/undefined), update() will fall back to the
    // target setpoint so controllers don't display 0°C.
    localTemperature: toMatterTemp(attributes.current_temperature),
    occupiedHeatingSetpoint:
      toMatterTemp(attributes.target_temp_low) ??
      toMatterTemp(attributes.temperature) ??
      2000,
    occupiedCoolingSetpoint:
      toMatterTemp(attributes.target_temp_high) ??
      toMatterTemp(attributes.temperature) ??
      2400,
    // Use HA's actual min/max limits, fall back to wide range (0-50°C) if not
    // provided. Ordered above so min <= max always holds.
    minHeatSetpointLimit: minLimit,
    maxHeatSetpointLimit: maxLimit,
    minCoolSetpointLimit: minLimit,
    maxCoolSetpointLimit: maxLimit,
  };

  // AutoMode is only safe when the device truly supports dual-setpoint
  // operation (HA heat_cool). For HA's single-setpoint 'auto' the Auto tile
  // in Apple Home doesn't write SystemMode.Auto, it writes Cool/Heat based
  // on its own heuristics, so HA ends up in cool/heat instead of auto (#309).
  // Without AutoMode, getSystemMode maps HA auto to Cool/Heat dynamically.
  const autoMode =
    supportsHeating &&
    supportsCooling &&
    attributes.hvac_modes.includes(ClimateHvacMode.heat_cool) &&
    (attributes.hvac_modes.includes(ClimateHvacMode.heat) ||
      attributes.hvac_modes.includes(ClimateHvacMode.cool));

  // Pass thermostat state at the endpoint type level using the behavior ID,
  // so matter.js's internal validation sees the values before initialize.
  // Only include attributes for the features the device actually supports.
  return ClimateDeviceType(
    supportsOnOff,
    supportsHumidity,
    supportsFanMode,
    supportsAutoFanMode,
    rockSupport,
    hasBattery,
    {
      heating: supportsHeating,
      cooling: supportsCooling,
      autoMode,
    },
    initialState,
    includeBasicInformation,
  ).set({
    homeAssistantEntity,
    thermostat: {
      // IMPORTANT: abs limits → regular limits → setpoints to prevent
      // validation failures for negative temperatures (e.g. refrigerators).
      ...(supportsHeating
        ? {
            absMinHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
            absMaxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
            minHeatSetpointLimit: initialState.minHeatSetpointLimit ?? 0,
            maxHeatSetpointLimit: initialState.maxHeatSetpointLimit ?? 5000,
            occupiedHeatingSetpoint:
              initialState.occupiedHeatingSetpoint ?? 2000,
          }
        : {}),
      ...(supportsCooling
        ? {
            absMinCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
            absMaxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
            minCoolSetpointLimit: initialState.minCoolSetpointLimit ?? 0,
            maxCoolSetpointLimit: initialState.maxCoolSetpointLimit ?? 5000,
            occupiedCoolingSetpoint:
              initialState.occupiedCoolingSetpoint ?? 2400,
          }
        : {}),
      localTemperature: initialState.localTemperature ?? null,
      // minSetpointDeadBand only valid with AutoMode (dual setpoint) feature
      ...(autoMode ? { minSetpointDeadBand: 0 } : {}),
    },
  });
}
