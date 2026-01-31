import type {
  EntityMappingConfig,
  FanDeviceAttributes,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { FanControl } from "@matter/main/clusters";
import { FanDevice as Device } from "@matter/main/devices";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import {
  FanCommands,
  LightCommands,
} from "../../behaviors/callback-behavior.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { FanBehavior } from "./behaviors/fan-behavior.js";
import { OnOffBehavior } from "./behaviors/on-off-behavior.js";
import { type BehaviorCommand, DomainEndpoint } from "./domain-endpoint.js";

const FanDeviceType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  OnOffBehavior,
  FanBehavior,
);

/**
 * FanEndpoint - Vision 1 implementation for fan entities.
 */
export class FanEndpoint extends DomainEndpoint {
  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
  ): Promise<FanEndpoint | undefined> {
    const state = registry.initialState(entityId);
    const entity = registry.entity(entityId);
    const deviceRegistry = registry.deviceOf(entityId);

    if (!state) {
      return undefined;
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
    return new FanEndpoint(
      FanDeviceType.set({ homeAssistantEntity }),
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

  protected onEntityStateChanged(entity: HomeAssistantEntityInformation): void {
    if (!entity.state) return;

    const isOn =
      entity.state.state !== "off" && entity.state.state !== "unavailable";
    const attributes = entity.state.attributes as FanDeviceAttributes;
    const percentage = attributes.percentage ?? 0;

    // Map percentage to Matter speed (0-100)
    const speedSetting = Math.round(percentage);
    const fanMode = isOn ? FanControl.FanMode.On : FanControl.FanMode.Off;

    try {
      this.setStateOf(OnOffBehavior, { onOff: isOn });
      this.setStateOf(FanBehavior, {
        fanMode,
        percentCurrent: percentage,
        percentSetting: percentage,
        speedCurrent: speedSetting,
        speedSetting: speedSetting,
      });
    } catch {
      // Behavior may not be initialized yet
    }
  }

  protected onBehaviorCommand(command: BehaviorCommand): void {
    switch (command.command) {
      case LightCommands.TURN_ON:
        this.callAction("fan", "turn_on");
        break;
      case LightCommands.TURN_OFF:
        this.callAction("fan", "turn_off");
        break;
      case FanCommands.SET_SPEED: {
        const args = command.args as { speed?: number } | undefined;
        if (args?.speed != null) {
          this.callAction("fan", "set_percentage", { percentage: args.speed });
        }
        break;
      }
    }
  }
}
