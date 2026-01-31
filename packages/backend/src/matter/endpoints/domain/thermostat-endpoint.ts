import {
  type ClimateDeviceAttributes,
  ClimateDeviceFeature,
  ClimateHvacMode,
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import type { ClusterBehavior, EndpointType } from "@matter/main";
import type { Thermostat } from "@matter/main/clusters";
import { ThermostatDevice } from "@matter/main/devices";
import type { ClusterType } from "@matter/main/types";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { InvalidDeviceError } from "../../../utils/errors/invalid-device-error.js";
import type { FeatureSelection } from "../../../utils/feature-selection.js";
import { testBit } from "../../../utils/test-bit.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { ClimateHumidityMeasurementServer } from "../legacy/climate/behaviors/climate-humidity-measurement-server.js";
import { ClimateOnOffServer } from "../legacy/climate/behaviors/climate-on-off-server.js";
import { ClimateThermostatServer } from "../legacy/climate/behaviors/climate-thermostat-server.js";
import { type BehaviorCommand, DomainEndpoint } from "./domain-endpoint.js";

const coolingModes: ClimateHvacMode[] = [
  ClimateHvacMode.heat_cool,
  ClimateHvacMode.cool,
];

const heatingModes: ClimateHvacMode[] = [
  ClimateHvacMode.heat_cool,
  ClimateHvacMode.heat,
];

/**
 * ThermostatEndpoint - Vision 1 implementation for climate entities.
 *
 * This endpoint uses the proven legacy behaviors but provides:
 * - Domain-specific coordination
 * - Access to neighbor entities (e.g., external temperature sensors)
 * - Clean separation between endpoint logic and behavior logic
 *
 * The behaviors handle:
 * - Self-updating via HomeAssistantEntityBehavior.onChange
 * - Matter commands (setpoint changes, mode changes)
 * - HA service calls
 * - Deadband constraint enforcement (2.5°C margin)
 */
export class ThermostatEndpoint extends DomainEndpoint {
  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
  ): Promise<ThermostatEndpoint | undefined> {
    const state = registry.initialState(entityId);
    const entity = registry.entity(entityId);
    const deviceRegistry = registry.deviceOf(entityId);

    if (!state) {
      return undefined;
    }

    const attributes = state.attributes as ClimateDeviceAttributes;
    const supportedFeatures = attributes.supported_features ?? 0;
    const hvacModes = attributes.hvac_modes ?? [];

    const supportsCooling = coolingModes.some((mode) =>
      hvacModes.includes(mode),
    );
    const supportsHeating = heatingModes.some((mode) =>
      hvacModes.includes(mode),
    );
    const supportsHumidity = testBit(
      supportedFeatures,
      ClimateDeviceFeature.TARGET_HUMIDITY,
    );
    const supportsOnOff =
      testBit(supportedFeatures, ClimateDeviceFeature.TURN_ON) &&
      testBit(supportedFeatures, ClimateDeviceFeature.TURN_OFF);

    // Validate that we have at least heating or cooling
    if (!supportsCooling && !supportsHeating) {
      throw new InvalidDeviceError(
        'Climate entities must support either "heating" or "cooling". Just "auto" is not enough.',
      );
    }

    const homeAssistantEntity: HomeAssistantEntityBehavior.State = {
      entity: {
        entity_id: entityId,
        state,
        registry: entity,
        deviceRegistry,
      } as HomeAssistantEntityInformation,
    };

    const deviceType = ThermostatEndpoint.createDeviceType(
      supportsCooling,
      supportsHeating,
      supportsOnOff,
      supportsHumidity,
    );

    const customName = mapping?.customName;
    return new ThermostatEndpoint(
      deviceType.set({ homeAssistantEntity }),
      entityId,
      customName,
    );
  }

  private static createDeviceType(
    supportsCooling: boolean,
    supportsHeating: boolean,
    supportsOnOff: boolean,
    supportsHumidity: boolean,
  ) {
    // Build thermostat features array
    // Note: AutoMode is intentionally NOT added here.
    // Matter.js has an internal issue with thermostatRunningMode permissions
    // when AutoMode is enabled. See Matter.js Issue #3105.
    const features: FeatureSelection<ClusterType.Of<Thermostat.Complete>> = [];
    if (supportsCooling) {
      features.push("Cooling");
    }
    if (supportsHeating) {
      features.push("Heating");
    }

    if (features.length === 0) {
      throw new InvalidDeviceError(
        'Climate entities must support either "heating" or "cooling".',
      );
    }

    const additionalClusters: ClusterBehavior.Type[] = [];

    if (supportsOnOff) {
      additionalClusters.push(ClimateOnOffServer);
    }
    if (supportsHumidity) {
      additionalClusters.push(ClimateHumidityMeasurementServer);
    }

    return ThermostatDevice.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
      ClimateThermostatServer.with(...features),
      ...additionalClusters,
    );
  }

  private externalTemperatureSensor?: string;

  private constructor(
    type: EndpointType,
    entityId: string,
    customName?: string,
  ) {
    super(type, entityId, customName);
  }

  /**
   * Handle HA entity state changes.
   * Checks for external temperature sensors from neighbor entities.
   */
  protected onEntityStateChanged(entity: HomeAssistantEntityInformation): void {
    // Check if the climate entity lacks current_temperature
    const attributes = entity.state?.attributes as ClimateDeviceAttributes;
    if (attributes?.current_temperature == null) {
      // Try to find an external temperature sensor from neighbor entities
      this.tryUseExternalTemperatureSensor();
    }
  }

  /**
   * Handle neighbor entity state changes.
   * Updates external temperature if using a neighbor temperature sensor.
   */
  protected override onNeighborStateChanged(
    entityId: string,
    _entity: HomeAssistantEntityInformation,
  ): void {
    if (entityId === this.externalTemperatureSensor) {
      // External temperature sensor updated - behaviors will pick this up
      // via their next state update cycle
    }
  }

  /**
   * Try to use an external temperature sensor from neighbor entities.
   * This is useful for climate entities that don't report current_temperature
   * but have a temperature sensor in the same device.
   */
  private tryUseExternalTemperatureSensor(): void {
    if (this.externalTemperatureSensor) {
      return; // Already configured
    }

    // Find temperature sensors in neighbor entities
    const tempSensors = this.findNeighborsByDeviceClass("temperature");
    if (tempSensors.length > 0) {
      const sensor = tempSensors[0];
      this.externalTemperatureSensor = sensor.entity_id;
      // Log that we're using an external sensor
      // The actual temperature reading will be handled by the behavior
      // via the neighbor entity's state
    }
  }

  /**
   * Get external temperature from neighbor sensor if available.
   * This can be used by behaviors to supplement missing current_temperature.
   */
  public getExternalTemperature(): number | undefined {
    if (!this.externalTemperatureSensor) {
      return undefined;
    }
    const sensor = this.getNeighborEntity(this.externalTemperatureSensor);
    const temp = sensor?.state?.state;
    if (temp != null && !Number.isNaN(+temp)) {
      return +temp;
    }
    return undefined;
  }

  /**
   * Handle Matter commands from controllers.
   */
  protected onBehaviorCommand(_command: BehaviorCommand): void {
    // Behaviors handle their own commands.
  }
}
