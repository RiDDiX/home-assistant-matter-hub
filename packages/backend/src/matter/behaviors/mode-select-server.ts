import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { ModeSelectServer as Base } from "@matter/main/behaviors";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { trimToLength } from "../../utils/trim-to-length.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("ModeSelectServer");

// SupportedModes holds at most 255 entries, later options are not exposed
const MAX_MODES = 255;

export function buildSupportedModes(options: string[]) {
  return options.slice(0, MAX_MODES).map((label, index) => ({
    label: trimToLength(label, 64, "") ?? label,
    mode: index,
    semanticTags: [],
  }));
}

export function findCurrentMode(options: string[], current?: string | null) {
  const index = current
    ? options.findIndex((o) => o.toLowerCase() === current.toLowerCase())
    : -1;
  return index >= 0 && index < MAX_MODES ? index : 0;
}

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
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const config = this.state.config;
    const options = config.getOptions(entity);
    const current = config.getCurrentOption(entity);

    if (options.length === 0) {
      return;
    }

    applyPatchState(this.state, {
      supportedModes: buildSupportedModes(options),
      currentMode: findCurrentMode(options, current),
    });
  }

  override changeToMode(request: { newMode: number }) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;
    const options = config.getOptions(homeAssistant.entity);
    const { newMode } = request;

    if (newMode < 0 || newMode >= Math.min(options.length, MAX_MODES)) {
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
