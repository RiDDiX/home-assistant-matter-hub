import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { ValveConfigurationAndControlServer as Base } from "@matter/main/behaviors";
import type { ValveConfigurationAndControl } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

export interface ValveConfigurationAndControlServerConfig {
  getCurrentState: ValueGetter<ValveConfigurationAndControl.ValveState>;
  open: ValueSetter<void>;
  close: ValueSetter<void>;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class ValveConfigurationAndControlServerBase extends Base {
  declare state: ValveConfigurationAndControlServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state) {
      return;
    }
    const config = this.state.config;
    const currentState = config.getCurrentState(entity.state, this.agent);

    applyPatchState(this.state, {
      currentState,
      targetState: currentState,
    });
  }

  override open() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.open(void 0, this.agent));
  }

  override close() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    homeAssistant.callAction(this.state.config.close(void 0, this.agent));
  }
}

namespace ValveConfigurationAndControlServerBase {
  export class State extends Base.State {
    config!: ValveConfigurationAndControlServerConfig;
  }
}

export function ValveConfigurationAndControlServer(
  config: ValveConfigurationAndControlServerConfig,
) {
  return ValveConfigurationAndControlServerBase.set({ config });
}
