import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { LevelControlServer as Base } from "@matter/main/behaviors";
import type { LevelControl } from "@matter/main/clusters/level-control";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import type { FeatureSelection } from "../../utils/feature-selection.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

// Track when lights were turned on to detect Alexa's brightness reset pattern
const lastTurnOnTimestamps = new Map<string, number>();
const LAST_TURN_ON_TTL_MS = 60_000;

// Track optimistic level writes to prevent stale HA state from overwriting them.
// After a controller command, the HA state update with the OLD brightness can
// arrive before HA processes the new command, causing the UI to revert.
// Instead of a blanket cooldown, we track the expected level and only skip HA
// updates that report a DIFFERENT (stale) value. Updates confirming the expected
// value (within tolerance) are accepted immediately.
interface OptimisticLevelState {
  expectedLevel: number;
  timestamp: number;
}
const optimisticLevelState = new Map<string, OptimisticLevelState>();
const OPTIMISTIC_TIMEOUT_MS = 3000;
const OPTIMISTIC_TOLERANCE = 5;

// Sweep stale entries so removed entities don't linger forever in either
// map. Cheap enough to call on every set/get of the involved entity.
function sweepOptimisticLevel(now: number) {
  for (const [key, value] of optimisticLevelState) {
    if (now - value.timestamp > OPTIMISTIC_TIMEOUT_MS) {
      optimisticLevelState.delete(key);
    }
  }
}
function sweepLastTurnOn(now: number) {
  for (const [key, ts] of lastTurnOnTimestamps) {
    if (now - ts > LAST_TURN_ON_TTL_MS) {
      lastTurnOnTimestamps.delete(key);
    }
  }
}

/**
 * Called by OnOffServer when a light is turned on via Matter command.
 * Used to detect Alexa's brightness reset pattern.
 */
export function notifyLightTurnedOn(entityId: string): void {
  const now = Date.now();
  sweepLastTurnOn(now);
  lastTurnOnTimestamps.set(entityId, now);
}

const logger = Logger.get("LevelControlServer");

export interface LevelControlConfig {
  getValuePercent: ValueGetter<number | null>;
  moveToLevelPercent: ValueSetter<number>;
}

const FeaturedBase = Base.with("OnOff", "Lighting");

export class LevelControlServerBase extends FeaturedBase {
  declare state: LevelControlServerBase.State;
  private pendingTransitionTime: number | undefined;

  override async initialize() {
    // Set default values BEFORE super.initialize() to prevent validation errors.
    // The Lighting feature requires currentLevel to be in valid range (1-254).
    // If the light is OFF, brightness from HA is null, which could cause issues.
    if (this.state.currentLevel == null) {
      this.state.currentLevel = 1; // Minimum valid level for Lighting feature
    }
    if (this.state.minLevel == null) {
      this.state.minLevel = 1;
    }
    if (this.state.maxLevel == null) {
      this.state.maxLevel = 0xfe; // 254
    }
    // Force onLevel to null so the base class's handleOnOffChange never
    // overwrites currentLevel when the device turns on. Without this,
    // Apple Home lights jump to 100% on every turn-on (#225).
    this.state.onLevel = null;

    try {
      await super.initialize();
    } catch (error) {
      logger.error("super.initialize() failed:", error);
      throw error;
    }
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const { state } = entity;
    const config = this.state.config;

    const minLevel = 1;
    const maxLevel = 0xfe;
    const levelRange = maxLevel - minLevel;

    // Get brightness as percentage (0.0-1.0) from Home Assistant
    const currentLevelPercent = config.getValuePercent(state, this.agent);
    let currentLevel =
      currentLevelPercent != null
        ? Math.round(currentLevelPercent * levelRange + minLevel)
        : null;

    if (currentLevel != null) {
      currentLevel = Math.min(Math.max(minLevel, currentLevel), maxLevel);
    }

    // Protect optimistic level from stale HA state updates.
    // Accept updates that confirm the expected value; skip stale ones.
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

  // Fix for Google Home (#41): it sends moveToLevel/moveToLevelWithOnOff/step commands
  // with transitionTime as null or completely omitted. The TLV schema is patched at startup
  // (see patch-level-control-tlv.ts) to accept omitted fields. Here we default to 0 (instant).
  override async moveToLevel(request: LevelControl.MoveToLevelRequest) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    this.pendingTransitionTime = request.transitionTime;
    return super.moveToLevel(request);
  }

  override async moveToLevelWithOnOff(
    request: LevelControl.MoveToLevelRequest,
  ) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    this.pendingTransitionTime = request.transitionTime;
    return super.moveToLevelWithOnOff(request);
  }

  override step(request: LevelControl.StepRequest) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    return super.step(request);
  }

  override stepWithOnOff(request: LevelControl.StepRequest) {
    if (request.transitionTime == null) {
      request.transitionTime = 0;
    }
    return super.stepWithOnOff(request);
  }

  override moveToLevelLogic(level: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const config = this.state.config;
    const entityId = homeAssistant.entity.entity_id;

    const levelRange = this.maxLevel - this.minLevel;
    const levelPercent = (level - this.minLevel) / levelRange;

    // Alexa workaround (#142, opt-in): after subscription renewal Alexa sends
    // on() followed by moveToLevel(254) within ~50ms, resetting brightness to
    // 100%. Apple Home's room-level "set to 100%" Siri command uses the same
    // on() + moveToLevel(254) pattern (#306), so this has to stay behind a
    // feature flag — dropping the command by default breaks Apple Home.
    const { featureFlags } = this.env.get(BridgeDataProvider);
    if (featureFlags?.alexaPreserveBrightnessOnTurnOn === true) {
      const lastTurnOn = lastTurnOnTimestamps.get(entityId);
      const timeSinceTurnOn = lastTurnOn ? Date.now() - lastTurnOn : Infinity;
      if (level >= this.maxLevel && timeSinceTurnOn < 200) {
        logger.debug(
          `[${entityId}] Ignoring moveToLevel(${level}) - Alexa brightness reset detected ` +
            `(${timeSinceTurnOn}ms after turn-on)`,
        );
        return;
      }
    }

    const current = config.getValuePercent(
      homeAssistant.entity.state,
      this.agent,
    );
    if (levelPercent === current) {
      return;
    }
    const action = config.moveToLevelPercent(levelPercent, this.agent);
    const transitionTimeTenths = this.pendingTransitionTime;
    this.pendingTransitionTime = undefined;
    if (transitionTimeTenths && transitionTimeTenths > 0) {
      action.data = {
        ...action.data,
        transition: transitionTimeTenths / 10,
      };
    }
    // Update currentLevel immediately so controllers get instant feedback
    // in the command response. Without this, Apple Home reads the stale
    // currentLevel before the HA state update arrives and reverts the UI.
    this.state.currentLevel = level;
    const now = Date.now();
    sweepOptimisticLevel(now);
    optimisticLevelState.set(entityId, {
      expectedLevel: level,
      timestamp: now,
    });
    homeAssistant.callAction(action);
  }
}

export namespace LevelControlServerBase {
  export class State extends FeaturedBase.State {
    config!: LevelControlConfig;
  }
}

export type LevelControlFeatures = FeatureSelection<LevelControl.Cluster>;

export function LevelControlServer(config: LevelControlConfig) {
  return LevelControlServerBase.set({
    options: { executeIfOff: true },
    config,
  });
}
