import {
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
  type LightDeviceAttributes,
  LightDeviceColorMode,
} from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { DimmableLightDevice, OnOffLightDevice } from "@matter/main/devices";
import type { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import { BasicInformationServer } from "../../behaviors/basic-information-server.js";
import { LightCommands } from "../../behaviors/callback-behavior.js";
import { HomeAssistantEntityBehavior } from "../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../behaviors/identify-server.js";
import { LevelControlBehavior } from "./behaviors/level-control-behavior.js";
import { OnOffBehavior } from "./behaviors/on-off-behavior.js";
import { type BehaviorCommand, DomainEndpoint } from "./domain-endpoint.js";

const brightnessModes: LightDeviceColorMode[] = Object.values(
  LightDeviceColorMode,
)
  .filter((mode) => mode !== LightDeviceColorMode.UNKNOWN)
  .filter((mode) => mode !== LightDeviceColorMode.ONOFF);

const OnOffLightType = OnOffLightDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  OnOffBehavior,
);

const DimmableLightType = DimmableLightDevice.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  OnOffBehavior,
  LevelControlBehavior,
);

/**
 * LightEndpoint - Vision 1 implementation for light entities.
 *
 * This endpoint:
 * - Receives entity state changes and updates behavior states
 * - Receives command callbacks from behaviors and calls HA services
 */
export class LightEndpoint extends DomainEndpoint {
  private supportsBrightness = false;

  public static async create(
    registry: BridgeRegistry,
    entityId: string,
    mapping?: EntityMappingConfig,
  ): Promise<LightEndpoint | undefined> {
    const state = registry.initialState(entityId);
    const entity = registry.entity(entityId);
    const deviceRegistry = registry.deviceOf(entityId);

    if (!state) {
      return undefined;
    }

    const attributes = state.attributes as LightDeviceAttributes;
    const supportedColorModes: LightDeviceColorMode[] =
      attributes.supported_color_modes ?? [];

    const supportsBrightness = supportedColorModes.some((mode) =>
      brightnessModes.includes(mode),
    );

    const homeAssistantEntity: HomeAssistantEntityBehavior.State = {
      entity: {
        entity_id: entityId,
        state,
        registry: entity,
        deviceRegistry,
      } as HomeAssistantEntityInformation,
    };

    const deviceType = supportsBrightness ? DimmableLightType : OnOffLightType;

    const customName = mapping?.customName;
    const endpoint = new LightEndpoint(
      deviceType.set({ homeAssistantEntity }),
      entityId,
      customName,
    );
    endpoint.supportsBrightness = supportsBrightness;
    return endpoint;
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
    const attributes = entity.state.attributes as LightDeviceAttributes;

    try {
      this.setStateOf(OnOffBehavior, { onOff: isOn });

      if (this.supportsBrightness) {
        const brightness = attributes.brightness ?? 0;
        this.setStateOf(LevelControlBehavior, { currentLevel: brightness });
      }
    } catch {
      // Behavior may not be initialized yet
    }
  }

  protected onBehaviorCommand(command: BehaviorCommand): void {
    switch (command.command) {
      case LightCommands.TURN_ON:
        this.callAction("light", "turn_on");
        break;
      case LightCommands.TURN_OFF:
        this.callAction("light", "turn_off");
        break;
      case LightCommands.SET_BRIGHTNESS: {
        const args = command.args as
          | { level?: number; withOnOff?: boolean }
          | undefined;
        if (args?.level != null) {
          this.callAction("light", "turn_on", { brightness: args.level });
        }
        break;
      }
    }
  }
}
