import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { ModeSelectServer as Base } from "@matter/main/behaviors";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("ModeSelectServer");

export interface SelectModeConfig {
  getOptions: (entity: HomeAssistantEntityInformation) => string[];
  getCurrentOption: (
    entity: HomeAssistantEntityInformation,
  ) => string | undefined;
  selectOption: (option: string) => HomeAssistantAction;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by the factory function below
class ModeSelectServerBase extends Base {
  declare state: ModeSelectServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const config = this.state.config;
    const options = config.getOptions(entity);
    const current = config.getCurrentOption(entity);

    if (options.length === 0) {
      return;
    }

    const currentIndex = current
      ? options.findIndex((o) => o.toLowerCase() === current.toLowerCase())
      : -1;

    applyPatchState(this.state, {
      currentMode: currentIndex >= 0 ? currentIndex : 0,
    });
  }

  override changeToMode(request: { newMode: number }) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;
    const options = config.getOptions(homeAssistant.entity);
    const { newMode } = request;

    if (newMode < 0 || newMode >= options.length) {
      logger.warn(
        `[${homeAssistant.entityId}] Invalid mode ${newMode}, options: [${options.join(", ")}]`,
      );
      return;
    }

    const option = options[newMode];
    logger.info(
      `[${homeAssistant.entityId}] changeToMode(${newMode}) -> "${option}"`,
    );

    applyPatchState(this.state, { currentMode: newMode });
    homeAssistant.callAction(config.selectOption(option));
  }
}

namespace ModeSelectServerBase {
  export class State extends Base.State {
    config!: SelectModeConfig;
  }
}

export function ModeSelectServer(config: SelectModeConfig) {
  return ModeSelectServerBase.set({ config });
}
