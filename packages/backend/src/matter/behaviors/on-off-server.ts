import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { OnOffServer as Base } from "@matter/main/behaviors";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { notifyLightTurnedOn } from "./level-control-server.js";
import type { ValueGetter } from "./utils/cluster-config.js";

const logger = Logger.get("OnOffServer");

// Track optimistic on/off writes to prevent stale HA state from reverting them.
// After a controller command, composed/mapped entity updates can re-push the
// primary entity state before HA processes the command, reverting the optimistic
// value. Only skip HA updates that report a DIFFERENT (stale) value; accept
// updates that confirm the expected value immediately.
interface OptimisticOnOffState {
  expectedOnOff: boolean;
  timestamp: number;
}
const optimisticOnOffState = new Map<string, OptimisticOnOffState>();
const OPTIMISTIC_TIMEOUT_MS = 3000;

// Sweep stale entries on every set so removed entities don't linger in the
// map for the lifetime of the process.
function sweepOptimisticOnOff(now: number) {
  for (const [key, value] of optimisticOnOffState) {
    if (now - value.timestamp > OPTIMISTIC_TIMEOUT_MS) {
      optimisticOnOffState.delete(key);
    }
  }
}

type OnOffCallback = (
  value: undefined,
  agent: Agent,
) => HomeAssistantAction | undefined;

export interface OnOffConfig {
  isOn?: ValueGetter<boolean>;
  turnOn?: OnOffCallback | null;
  turnOff?: OnOffCallback | null;
}

// biome-ignore lint/correctness/noUnusedVariables: Biome thinks this is unused, but it's used by the function below
class OnOffServerBase extends Base {
  declare state: OnOffServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  protected update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const { state } = entity;
    const onOff = this.isOn(state);
    const entityId = this.agent.get(HomeAssistantEntityBehavior).entity
      .entity_id;
    const optimistic = optimisticOnOffState.get(entityId);
    if (optimistic != null) {
      if (Date.now() - optimistic.timestamp > OPTIMISTIC_TIMEOUT_MS) {
        optimisticOnOffState.delete(entityId);
      } else if (onOff === optimistic.expectedOnOff) {
        optimisticOnOffState.delete(entityId);
      } else {
        return;
      }
    }
    applyPatchState(this.state, { onOff });
  }

  private isOn(entity: HomeAssistantEntityState): boolean {
    return (
      this.state.config?.isOn?.(entity, this.agent) ??
      (this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
        entity.state !== "off")
    );
  }

  override on() {
    const { turnOn, turnOff } = this.state.config;
    if (turnOn === null) {
      setTimeout(this.callback(this.autoReset), 1000);
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = turnOn
      ? turnOn(void 0, this.agent)
      : { action: "homeassistant.turn_on" as const };
    // Set onOff immediately so the controller gets instant feedback in the
    // command response. Without this, Apple Home shows "Turning on..." until
    // the async HA WebSocket state update arrives.
    applyPatchState(this.state, { onOff: true });
    if (!action) {
      // Callback explicitly returned undefined = skip HA action
      // (e.g., climate already on — no need to send turn_on)
      return;
    }
    logger.info(`[${homeAssistant.entityId}] Turning ON -> ${action.action}`);
    // Notify LevelControlServer about turn-on for Alexa brightness workaround
    notifyLightTurnedOn(homeAssistant.entityId);
    const now = Date.now();
    sweepOptimisticOnOff(now);
    optimisticOnOffState.set(homeAssistant.entityId, {
      expectedOnOff: true,
      timestamp: now,
    });
    homeAssistant.callAction(action);
    // Auto-reset for momentary actions (scenes, automations) so controllers
    // don't show a permanently "on" state after activation.
    if (turnOff === null) {
      setTimeout(this.callback(this.autoReset), 1000);
    }
  }

  override off() {
    const { turnOff } = this.state.config;
    if (turnOff === null) {
      setTimeout(this.callback(this.autoReset), 1000);
      return;
    }
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const action = turnOff
      ? turnOff(void 0, this.agent)
      : { action: "homeassistant.turn_off" as const };
    // Set onOff immediately so the controller gets instant feedback in the
    // command response. Without this, Apple Home shows "Turning off..." until
    // the async HA WebSocket state update arrives (#219).
    applyPatchState(this.state, { onOff: false });
    if (!action) {
      return;
    }
    logger.info(`[${homeAssistant.entityId}] Turning OFF -> ${action.action}`);
    const now = Date.now();
    sweepOptimisticOnOff(now);
    optimisticOnOffState.set(homeAssistant.entityId, {
      expectedOnOff: false,
      timestamp: now,
    });
    homeAssistant.callAction(action);
  }

  private autoReset() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    optimisticOnOffState.delete(homeAssistant.entityId);
    this.update(homeAssistant.entity);
  }
}

namespace OnOffServerBase {
  export class State extends Base.State {
    config!: OnOffConfig;
  }
}

export function OnOffServer(config: OnOffConfig = {}) {
  return OnOffServerBase.set({ config });
}

export function setOptimisticOnOff(entityId: string, expectedOnOff: boolean) {
  const now = Date.now();
  sweepOptimisticOnOff(now);
  optimisticOnOffState.set(entityId, {
    expectedOnOff,
    timestamp: now,
  });
}
