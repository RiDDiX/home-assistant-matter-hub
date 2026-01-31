import {
  type ClimateDeviceAttributes,
  ClimateDeviceFeature,
  ClimateHvacMode,
} from "@home-assistant-matter-hub/common";
import type { ClusterBehavior, EndpointType } from "@matter/main";
import type { Thermostat } from "@matter/main/clusters";
import {
  RoomAirConditionerDevice,
  ThermostatDevice,
} from "@matter/main/devices";
import type { ClusterType } from "@matter/main/types";
import { InvalidDeviceError } from "../../../../utils/errors/invalid-device-error.js";
import type { FeatureSelection } from "../../../../utils/feature-selection.js";
import { testBit } from "../../../../utils/test-bit.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { ClimateFanControlServer } from "./behaviors/climate-fan-control-server.js";
import { ClimateHumidityMeasurementServer } from "./behaviors/climate-humidity-measurement-server.js";
import { ClimateOnOffServer } from "./behaviors/climate-on-off-server.js";
import { ClimateThermostatServer } from "./behaviors/climate-thermostat-server.js";

function thermostatFeatures(
  supportsCooling: boolean,
  supportsHeating: boolean,
) {
  const features: FeatureSelection<ClusterType.Of<Thermostat.Complete>> =
    new Set();
  if (supportsCooling) {
    features.add("Cooling");
  }
  if (supportsHeating) {
    features.add("Heating");
  }
  if (supportsHeating && supportsCooling) {
    features.add("AutoMode");
  }
  return features;
}

const ClimateDeviceType = (
  supportsCooling: boolean,
  supportsHeating: boolean,
  supportsOnOff: boolean,
  supportsHumidity: boolean,
  supportsFanMode: boolean,
) => {
  const features = thermostatFeatures(supportsCooling, supportsHeating);
  if (features.size === 0) {
    throw new InvalidDeviceError(
      'Climates have to support either "heating" or "cooling". Just "auto" is not enough.',
    );
  }

  const additionalClusters: ClusterBehavior.Type[] = [];

  if (supportsOnOff) {
    additionalClusters.push(ClimateOnOffServer);
  }
  if (supportsHumidity) {
    additionalClusters.push(ClimateHumidityMeasurementServer);
  }

  // Use RoomAirConditionerDevice for climate entities with fan_mode support
  // This exposes both Thermostat and FanControl clusters
  if (supportsFanMode) {
    return RoomAirConditionerDevice.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
      ClimateThermostatServer.with(...features),
      ClimateFanControlServer,
      ...additionalClusters,
    );
  }

  return ThermostatDevice.with(
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    ClimateThermostatServer.with(...features),
    ...additionalClusters,
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

export function ClimateDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attributes = homeAssistantEntity.entity.state
    .attributes as ClimateDeviceAttributes;
  const supportedFeatures = attributes.supported_features ?? 0;

  const supportsCooling = coolingModes.some((mode) =>
    attributes.hvac_modes.includes(mode),
  );
  const hasExplicitHeating = heatingModes.some((mode) =>
    attributes.hvac_modes.includes(mode),
  );
  // Treat auto-only thermostats (no heat/cool/heat_cool) as heating devices
  // This allows simple thermostats that only have "auto" mode to work
  const isAutoOnly =
    !hasExplicitHeating &&
    !supportsCooling &&
    autoOnlyMode.some((mode) => attributes.hvac_modes.includes(mode));
  const supportsHeating = hasExplicitHeating || isAutoOnly;
  // Check if current_humidity attribute exists (not just TARGET_HUMIDITY feature)
  // Many devices report humidity without supporting target humidity control
  const supportsHumidity =
    attributes.current_humidity != null ||
    testBit(supportedFeatures, ClimateDeviceFeature.TARGET_HUMIDITY);
  const supportsOnOff =
    testBit(supportedFeatures, ClimateDeviceFeature.TURN_ON) &&
    testBit(supportedFeatures, ClimateDeviceFeature.TURN_OFF);
  const supportsFanMode = testBit(
    supportedFeatures,
    ClimateDeviceFeature.FAN_MODE,
  );

  return ClimateDeviceType(
    supportsCooling,
    supportsHeating,
    supportsOnOff,
    supportsHumidity,
    supportsFanMode,
  ).set({ homeAssistantEntity });
}
