import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { LevelControlServer as Base } from "@matter/main/behaviors";
import type { LevelControl } from "@matter/main/clusters/level-control";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import type { FeatureSelection } from "../../utils/feature-selection.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("LevelControlServer");

export interface LevelControlConfig {
  getValuePercent: ValueGetter<number | null>;
  moveToLevelPercent: ValueSetter<number>;
}

const FeaturedBase = Base.with("OnOff", "Lighting");

export class LevelControlServerBase extends FeaturedBase {
  declare state: LevelControlServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update({ state }: HomeAssistantEntityInformation) {
    const config = this.state.config;

    const minLevel = 1;
    const maxLevel = 0xfe;
    const levelRange = maxLevel - minLevel;

    const currentLevelPercent =
      config.getValuePercent(state, this.agent) ??
      this.state.currentLevelPercent;
    let currentLevel =
      currentLevelPercent != null
        ? currentLevelPercent * levelRange + minLevel
        : null;

    if (currentLevel != null) {
      currentLevel = Math.min(Math.max(minLevel, currentLevel), maxLevel);
    }

    // Only update onLevel when the entity is ON and has a valid brightness above minimum.
    // This preserves the last known brightness level when the light is turned off,
    // so controllers like Alexa can restore it on the next turn-on.
    const isEntityOn = state.state !== "off" && state.state !== "unavailable";
    const hasValidBrightness = currentLevel != null && currentLevel > minLevel;
    const previousOnLevel = this.state.onLevel;
    const newOnLevel =
      isEntityOn && hasValidBrightness
        ? currentLevel
        : (this.state.onLevel ?? currentLevel);

    // Debug logging to help investigate brightness persistence issues
    if (previousOnLevel !== newOnLevel) {
      const entityId = this.agent.get(HomeAssistantEntityBehavior).entity
        .entity_id;
      logger.debug(
        `[${entityId}] onLevel changed: ${previousOnLevel} -> ${newOnLevel} ` +
          `(state=${state.state}, currentLevel=${currentLevel}, isOn=${isEntityOn})`,
      );
    }

    applyPatchState(this.state, {
      minLevel: minLevel,
      maxLevel: maxLevel,
      currentLevel: currentLevel,
      currentLevelPercent: currentLevelPercent,
      onLevel: newOnLevel,
    });
  }

  // Fix for Google Home: it sends moveToLevel/moveToLevelWithOnOff with transitionTime as null or omitted.
  // According to Matter spec, transitionTime is nullable, but Matter.js validation fails on null/undefined.
  // We provide a default value of 0 (instant transition) to prevent validation errors.
  override async moveToLevel(request: LevelControl.MoveToLevelRequest) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    return super.moveToLevel(request);
  }

  override async moveToLevelWithOnOff(
    request: LevelControl.MoveToLevelRequest,
  ) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    return super.moveToLevelWithOnOff(request);
  }

  override moveToLevelLogic(level: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;

    const levelRange = this.maxLevel - this.minLevel;
    const levelPercent = (level - this.minLevel) / levelRange;

    const current = config.getValuePercent(
      homeAssistant.entity.state,
      this.agent,
    );
    if (levelPercent === current) {
      return;
    }
    homeAssistant.callAction(
      config.moveToLevelPercent(levelPercent, this.agent),
    );
  }
}

export namespace LevelControlServerBase {
  export class State extends FeaturedBase.State {
    config!: LevelControlConfig;
    currentLevelPercent: number | null = null;
  }
}

export type LevelControlFeatures = FeatureSelection<LevelControl.Cluster>;

export function LevelControlServer(config: LevelControlConfig) {
  return LevelControlServerBase.set({
    options: { executeIfOff: true },
    config,
  });
}
