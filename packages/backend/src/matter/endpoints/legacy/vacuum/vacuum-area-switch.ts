import type {
  HomeAssistantEntityInformation,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import type { HomeAssistantStates } from "../../../../services/home-assistant/home-assistant-registry.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";
import { EntityEndpoint } from "../../entity-endpoint.js";
import { updateEntityState } from "../../update-entity-state.js";
import { dispatchRoomClean } from "./behaviors/vacuum-rvc-run-mode-server.js";
import type {
  VacuumArea,
  VacuumEffectiveConfig,
} from "./behaviors/vacuum-service-area-server.js";

/**
 * A momentary On/Off plug sibling to the vacuum, one per service area (#355).
 * Turning it on starts cleaning that single area via the same dispatch the
 * RvcRunMode start path uses; it auto-resets after the momentary window and off
 * is a no-op. It shares the vacuum's entity_id (so state flows in) but carries
 * its own stable endpoint id and identity anchor, so the vacuum's own
 * id/number/uniqueId never change.
 */
export class VacuumAreaSwitchEndpoint extends EntityEndpoint {
  static create(params: {
    vacuumEndpointId: string;
    entity: HomeAssistantEntityInformation;
    mapping: HomeAssistantEntityBehavior.State["mapping"];
    area: VacuumArea;
    parentEffective: VacuumEffectiveConfig;
  }): VacuumAreaSwitchEndpoint {
    const { vacuumEndpointId, entity, mapping, area, parentEffective } = params;
    // roomsw marker keeps the derived id away from real entity ids like
    // vacuum.robot_area_16; the reconcile still guards the leftover risk.
    const endpointId = `${vacuumEndpointId}_roomsw_${area.areaId}`;
    const areaId = area.areaId;
    // The vacuum's serial belongs to the vacuum alone. Drop both serial
    // sources so BasicInformationServer derives one from the switch's own
    // identityAnchor instead.
    const switchMapping = mapping?.customSerialNumber
      ? { ...mapping, customSerialNumber: undefined }
      : mapping;
    const switchEntity = entity.deviceRegistry?.serial_number
      ? {
          ...entity,
          deviceRegistry: {
            ...entity.deviceRegistry,
            serial_number: undefined,
          },
        }
      : entity;

    const type = OnOffPlugInUnitDevice.with(
      BasicInformationServer,
      IdentifyServer,
      HomeAssistantEntityBehavior,
      OnOffServer({
        isOn: () => false,
        // off is a no-op (momentary auto-reset only, script pattern).
        turnOff: null,
        turnOn: (_value, agent) => {
          const ha = agent.get(HomeAssistantEntityBehavior);
          // Dispatch from the creation-time snapshot: live state gets
          // overwritten with raw HA attributes, which lack injected rooms.
          const { action } = dispatchRoomClean(
            parentEffective.state.attributes as VacuumDeviceAttributes,
            parentEffective.mapping,
            ha.entityId,
            [areaId],
            { callAction: (a) => ha.callAction(a) },
          );
          return action;
        },
      }),
    ).set({
      homeAssistantEntity: {
        entity: switchEntity,
        mapping: switchMapping,
        customName: area.name,
        // Distinct anchor so uniqueId/serial don't collide with the vacuum's,
        // and stay frozen across HA renames.
        identityAnchor: endpointId,
      },
    });

    return new VacuumAreaSwitchEndpoint(
      type,
      entity.entity_id,
      endpointId,
      areaId,
      vacuumEndpointId,
      parentEffective,
    );
  }

  private constructor(
    type: EndpointType,
    entityId: string,
    endpointId: string,
    readonly areaId: number,
    readonly vacuumEndpointId: string,
    // The exact effective config of the vacuum this switch was built from.
    // Compared by reference: a recreated vacuum gets a fresh one, which tells
    // the reconcile this switch is stale and must be rebuilt too.
    readonly parentEffective: VacuumEffectiveConfig,
  ) {
    super(type, entityId, undefined, [], endpointId);
  }

  async updateStates(states: HomeAssistantStates): Promise<void> {
    const state = states[this.entityId];
    if (!state) return;
    await updateEntityState(this, state);
  }
}
