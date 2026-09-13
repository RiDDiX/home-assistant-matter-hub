import type {
  HomeAssistantEntityInformation,
  WaterHeaterDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { WaterHeaterModeServer as Base } from "@matter/main/behaviors";
import { ModeUtils } from "@matter/main/behaviors/mode-base";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  currentMode,
  OFF_MODE,
  type WaterHeaterModeMapping,
} from "../water-heater-modes.js";

/**
 * WaterHeaterMode (0x009E) driven by the water_heater entity's operation modes.
 *
 * supportedModes has to be seeded before initialize() runs: the matter.js base
 * server asserts there that exactly one Off-tagged and one Manual-tagged mode
 * exist, and it validates every currentMode write against the list.
 */
// biome-ignore lint/correctness/noUnusedVariables: used by the factory below
class WaterHeaterModeServerBase extends Base {
  declare state: WaterHeaterModeServerBase.State;

  override async initialize() {
    // currentMode is quality N: a value stored by an earlier run overrides the
    // seeded default. When that mode has left operation_list since, the base
    // server's assertMode would brick the endpoint, so clamp it first.
    if (
      !this.state.supportedModes.some((m) => m.mode === this.state.currentMode)
    ) {
      const entityState = (await this.agent.load(HomeAssistantEntityBehavior))
        .entity.state;
      this.state.currentMode = entityState?.attributes
        ? currentMode(
            this.state.mapping,
            entityState.state,
            entityState.attributes as WaterHeaterDeviceAttributes,
          )
        : this.state.mapping.manualMode;
    }
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    // offline: true runs the reactor in its own transaction, otherwise writes
    // land after the parent transaction finalized and never reach subscribers.
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    applyPatchState(this.state, {
      currentMode: currentMode(
        this.state.mapping,
        entity.state.state,
        entity.state.attributes as WaterHeaterDeviceAttributes,
      ),
    });
  }

  override changeToMode(
    request: ModeBase.ChangeToModeRequest,
  ): ModeBase.ChangeToModeResponse {
    // Same validation the matter.js base server runs, inlined because its
    // changeToMode is typed MaybePromise and cannot be awaited from a
    // synchronous override.
    const response = ModeUtils.assertModeChange(
      this.state.supportedModes,
      this.state.currentMode,
      request.newMode,
    );
    if (response.status !== ModeBase.ModeChangeStatus.Success) {
      return response;
    }
    this.state.currentMode = request.newMode;

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const operationMode = this.state.mapping.haOperationModes[request.newMode];

    if (operationMode != null) {
      homeAssistant.callAction({
        action: "water_heater.set_operation_mode",
        data: { operation_mode: operationMode },
      });
    } else if (request.newMode === OFF_MODE) {
      homeAssistant.callAction({ action: "water_heater.turn_off", data: {} });
    } else {
      homeAssistant.callAction({ action: "water_heater.turn_on", data: {} });
    }
    return response;
  }
}

namespace WaterHeaterModeServerBase {
  export class State extends Base.State {
    mapping!: WaterHeaterModeMapping;
  }
}

export function WaterHeaterModeServer(
  mapping: WaterHeaterModeMapping,
  initialMode: number,
) {
  return WaterHeaterModeServerBase.set({
    mapping,
    supportedModes: mapping.supportedModes,
    currentMode: initialMode,
  });
}
