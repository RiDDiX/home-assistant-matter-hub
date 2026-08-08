import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { LevelControlServer as Base } from "@matter/main/behaviors";
import type { LevelControl } from "@matter/main/clusters/level-control";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("SpeakerLevelControlServer");

interface OptimisticLevelState {
  expectedLevel: number;
  timestamp: number;
}
const optimisticLevelState = new Map<string, OptimisticLevelState>();
const OPTIMISTIC_TIMEOUT_MS = 3000;
const OPTIMISTIC_TOLERANCE = 5;

function sweepOptimisticLevel(now: number) {
  for (const [key, value] of optimisticLevelState) {
    if (now - value.timestamp > OPTIMISTIC_TIMEOUT_MS) {
      optimisticLevelState.delete(key);
    }
  }
}

export interface SpeakerLevelControlConfig {
  getValuePercent: ValueGetter<number | null>;
  moveToLevelPercent: ValueSetter<number>;
}

/**
 * LevelControlServer for Speaker/MediaPlayer devices.
 *
 * Key difference from LevelControlServer (for lights):
 * - Does NOT use the "Lighting" feature
 * - Uses range 0-254 for currentLevel (Google Home calculates percentage as currentLevel/254)
 * - minLevel = 0, maxLevel = 254 (no +1 offset like lights)
 *
 * Google Home always calculates volume percentage as: currentLevel / 254 * 100
 * regardless of the maxLevel attribute value.
 */
const FeaturedBase = Base.with("OnOff");

export class SpeakerLevelControlServerBase extends FeaturedBase {
  declare state: SpeakerLevelControlServerBase.State;

  override async initialize() {
    // Set default values BEFORE super.initialize() to prevent validation errors.
    // Speaker uses 0-254 range (no Lighting feature, so 0 is valid).
    if (this.state.currentLevel == null) {
      this.state.currentLevel = 0; // Muted by default
    }
    if (this.state.minLevel == null) {
      this.state.minLevel = 0;
    }
    if (this.state.maxLevel == null) {
      this.state.maxLevel = 254;
    }
    // Force onLevel to null so the base class's handleOnOffChange never
    // overwrites currentLevel when the device turns on. Volume is managed
    // entirely through Home Assistant state updates, not on-level restoration.
    this.state.onLevel = null;

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const { state } = entity;
    const config = this.state.config;

    // For speakers, use 0-254 range (Google Home calculates: currentLevel / 254 * 100)
    // No +1 offset like lights - 0 means muted, 254 means max volume
    const minLevel = 0;
    const maxLevel = 254;

    // Get volume as percentage (0.0-1.0) from Home Assistant
    const currentLevelPercent = config.getValuePercent(state, this.agent);

    // Convert percentage (0.0-1.0) to 0-254 range
    let currentLevel =
      currentLevelPercent != null
        ? Math.round(currentLevelPercent * maxLevel)
        : null;

    if (currentLevel != null) {
      currentLevel = Math.min(Math.max(minLevel, currentLevel), maxLevel);
    }

    const entityId = this.agent.get(HomeAssistantEntityBehavior).entity
      .entity_id;
    logger.debug(
      `[${entityId}] Volume update: HA=${currentLevelPercent != null ? Math.round(currentLevelPercent * 100) : "null"}% -> currentLevel=${currentLevel}`,
    );

    const optimistic = optimisticLevelState.get(entity.entity_id);
    if (optimistic != null && currentLevel != null) {
      if (Date.now() - optimistic.timestamp > OPTIMISTIC_TIMEOUT_MS) {
        optimisticLevelState.delete(entity.entity_id);
      } else if (
        Math.abs(currentLevel - optimistic.expectedLevel) <=
        OPTIMISTIC_TOLERANCE
      ) {
        optimisticLevelState.delete(entity.entity_id);
      } else {
        currentLevel = null;
      }
    }

    applyPatchState(this.state, {
      minLevel: minLevel,
      maxLevel: maxLevel,
      ...(currentLevel != null ? { currentLevel: currentLevel } : {}),
    });
  }

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

  /**
   * Override to prevent the base LevelControlServer from resetting
   * currentLevel to onLevel whenever the OnOff state changes to ON.
   *
   * The base class registers a reactor on onOff$Changed that sets
   * currentLevel = onLevel. This is designed for lights (restore brightness
   * on power-on) but is wrong for speakers, it overwrites the correct
   * volume (e.g. 191 for 75%) with a stale onLevel value, causing Google
   * Home to display the wrong percentage (Issue #79).
   */
  override handleOnOffChange(_onOff: boolean) {
    // No-op: volume is driven by HA state, not by on-level restoration.
  }

  override moveToLevelLogic(level: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;
    const entityId = homeAssistant.entity.entity_id;

    // Level is 0-254, convert to 0.0-1.0 for HA
    const levelPercent = level / 254;

    logger.debug(
      `[${entityId}] Volume command: level=${level} -> HA volume_level=${levelPercent}`,
    );

    const current = config.getValuePercent(
      homeAssistant.entity.state,
      this.agent,
    );
    if (levelPercent === current) {
      return;
    }
    this.state.currentLevel = level;
    const now = Date.now();
    sweepOptimisticLevel(now);
    optimisticLevelState.set(entityId, {
      expectedLevel: level,
      timestamp: now,
    });
    homeAssistant.callAction(
      config.moveToLevelPercent(levelPercent, this.agent),
    );
  }
}

export namespace SpeakerLevelControlServerBase {
  export class State extends FeaturedBase.State {
    config!: SpeakerLevelControlConfig;
  }
}

export function SpeakerLevelControlServer(config: SpeakerLevelControlConfig) {
  return SpeakerLevelControlServerBase.set({
    options: { executeIfOff: true },
    config,
  });
}
