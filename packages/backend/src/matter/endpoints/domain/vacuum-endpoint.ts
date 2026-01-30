import {
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
  type VacuumDeviceAttributes,
  VacuumDeviceFeature,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { testBit } from "../../../utils/test-bit.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { VacuumOnOffServer } from "../legacy/vacuum/behaviors/vacuum-on-off-server.js";
import { VacuumPowerSourceServer } from "../legacy/vacuum/behaviors/vacuum-power-source-server.js";
import { VacuumRvcOperationalStateServer } from "../legacy/vacuum/behaviors/vacuum-rvc-operational-state-server.js";
import { VacuumRvcRunModeServer } from "../legacy/vacuum/behaviors/vacuum-rvc-run-mode-server.js";
import { type BehaviorCommand, DomainEndpoint } from "./domain-endpoint.js";

const VacuumEndpointType = RoboticVacuumCleanerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  VacuumRvcOperationalStateServer,
  VacuumRvcRunModeServer,
);

/**
 * VacuumEndpoint - Vision 1 implementation for vacuum entities.
 */
export class VacuumEndpoint extends DomainEndpoint {
  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
  ): Promise<VacuumEndpoint | undefined> {
    const state = registry.initialState(entityId);
    const entity = registry.entity(entityId);
    const deviceRegistry = registry.deviceOf(entityId);

    if (!state) {
      return undefined;
    }

    const attributes = state.attributes as VacuumDeviceAttributes;
    const supportedFeatures = attributes.supported_features ?? 0;

    let device = VacuumEndpointType;
    if (testBit(supportedFeatures, VacuumDeviceFeature.START)) {
      device = device.with(VacuumOnOffServer);
    }
    // Add PowerSource if BATTERY feature is set OR battery_level attribute exists
    const hasBatteryLevel =
      attributes.battery_level != null &&
      typeof attributes.battery_level === "number";
    if (
      testBit(supportedFeatures, VacuumDeviceFeature.BATTERY) ||
      hasBatteryLevel
    ) {
      device = device.with(VacuumPowerSourceServer);
    }

    const homeAssistantEntity: HomeAssistantEntityBehavior.State = {
      entity: {
        entity_id: entityId,
        state,
        registry: entity,
        deviceRegistry,
      } as HomeAssistantEntityInformation,
    };

    const customName = mapping?.customName;
    return new VacuumEndpoint(
      device.set({ homeAssistantEntity }),
      entityId,
      customName,
    );
  }

  private constructor(
    type: EndpointType,
    entityId: string,
    customName?: string,
  ) {
    super(type, entityId, customName);
  }

  protected onEntityStateChanged(
    _entity: HomeAssistantEntityInformation,
  ): void {
    // Behaviors handle their own state updates
  }

  protected onBehaviorCommand(_command: BehaviorCommand): void {
    // Behaviors handle their own commands
  }
}
