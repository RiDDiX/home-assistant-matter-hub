import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger, type Timer } from "@matter/general";
import type { Agent } from "@matter/main";
import {
  OnOffServer as Base,
  type OnOffBaseServer,
} from "@matter/main/behaviors";
import type { OnOff } from "@matter/main/clusters";
import type { HomeAssistantAction } from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import {
  notifyLightTurnedOff,
  notifyLightTurnedOn,
} from "./level-control-server.js";
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

// Override device types (on_off_plugin_unit, on_off_switch) route through this
// behavior instead of the valve/cover domain factory, so their native
// open/close wiring is skipped. homeassistant.turn_on/off is a no-op for those
// domains, so map them to the right service here (#65).
export function defaultOnOffAction(
  entityId: string,
  on: boolean,
): HomeAssistantAction {
  const domain = entityId.split(".")[0];
  if (domain === "valve") {
    return { action: on ? "valve.open_valve" : "valve.close_valve" };
  }
  if (domain === "cover") {
    return { action: on ? "cover.open_cover" : "cover.close_cover" };
  }
  return { action: on ? "homeassistant.turn_on" : "homeassistant.turn_off" };
}

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
    this.reactTo(homeAssistant.onChange, this.update, { lock: true });
    this.reactTo(homeAssistant.events.actionFailed, this.dropOptimistic);
  }

  private dropOptimistic() {
    optimisticOnOffState.delete(
      this.agent.get(HomeAssistantEntityBehavior).entityId,
    );
  }

  protected update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
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
      : defaultOnOffAction(homeAssistant.entityId, true);
    // Momentary entities (script/scene/automation/input_button) normally get
    // an optimistic onOff true plus a ~1s auto-reset to false, producing an
    // unsolicited on->off report pair per activation. Some Echo devices wedge
    // on that pair until restarted (#423). disableMomentaryFlip skips both:
    // the HA action still fires, but onOff stays off and never reports.
    const skipMomentaryFlip =
      turnOff === null && homeAssistant.state.mapping?.disableMomentaryFlip;
    if (!skipMomentaryFlip) {
      // Set onOff immediately so the controller gets instant feedback in the
      // command response. Without this, Apple Home shows "Turning on..." until
      // the async HA WebSocket state update arrives.
      applyPatchState(this.state, { onOff: true });
    }
    // Notify LevelControlServer about turn-on for Alexa brightness workaround,
    // also when no HA call goes out (#542)
    notifyLightTurnedOn(homeAssistant.entityId);
    if (!action) {
      // Callback explicitly returned undefined = skip HA action
      // (e.g., climate already on, no need to send turn_on)
      logger.debug(`[${homeAssistant.entityId}] Turning ON -> no HA call`);
      return;
    }
    logger.info(`[${homeAssistant.entityId}] Turning ON -> ${action.action}`);
    if (!skipMomentaryFlip) {
      const now = Date.now();
      sweepOptimisticOnOff(now);
      optimisticOnOffState.set(homeAssistant.entityId, {
        expectedOnOff: true,
        timestamp: now,
      });
    }
    homeAssistant.callAction(action);
    // Auto-reset for momentary actions (scenes, automations) so controllers
    // don't show a permanently "on" state after activation.
    if (turnOff === null && !skipMomentaryFlip) {
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
      : defaultOnOffAction(homeAssistant.entityId, false);
    // Set onOff immediately so the controller gets instant feedback in the
    // command response. Without this, Apple Home shows "Turning off..." until
    // the async HA WebSocket state update arrives (#219).
    applyPatchState(this.state, { onOff: false });
    // Tell LevelControlServer a Matter off just happened, so the level command
    // Google sends right after a room-off does not relight the room (#434).
    notifyLightTurnedOff(
      homeAssistant.entityId,
      homeAssistant.entity.state?.last_changed,
    );
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

// The Lighting timers are protected in matter.js and missing from the type.
type LightingTimers = {
  internal: OnOffBaseServer.Internal;
  delayedOffTimer: Timer;
};

// Lights and mounted switches run the matter.js OnWithTimedOff countdown. On
// and Off set OnTime and OffWaitTime as the spec says (1.5.7.1, 1.5.7.2), so
// the countdown never outlives a later Off. The timers sit outside the
// transaction, so they change only after the command went through.
class LightingOnOffServerBase extends OnOffServerBase.with("Lighting") {
  private timedOn = false;

  override on() {
    const result = super.on();
    // OnWithTimedOff keeps the OffWaitTime it was given (1.5.7.6.4)
    if (this.state.onTime === 0 && !this.timedOn) {
      this.timers.internal.delayedOffTimer?.stop();
      applyPatchState(this.state, { offWaitTime: 0 });
    }
    return result;
  }

  override off() {
    const result = super.off();
    this.timers.internal.timedOnTimer?.stop();
    applyPatchState(this.state, { onTime: 0 });
    if (
      this.state.offWaitTime > 0 &&
      this.state.offWaitTime !== 0xffff &&
      !this.timers.delayedOffTimer.isRunning
    ) {
      this.timers.delayedOffTimer.start();
    }
    return result;
  }

  // matter.js turns on through on(), where the On rule must not apply
  override onWithTimedOff(request: OnOff.OnWithTimedOffRequest) {
    this.timedOn = true;
    try {
      return super.onWithTimedOff(request);
    } finally {
      this.timedOn = false;
    }
  }

  private get timers() {
    return this as unknown as LightingTimers;
  }
}

export function LightingOnOffServer(config: OnOffConfig = {}) {
  return LightingOnOffServerBase.set({ config });
}

// Plug type endpoints need the Lighting feature, but its extra commands stay a
// plain on or off here: no timed off and no global scene recall, so a
// controller can never trigger a later off (disarm, close) on its own.
class PlugOnOffServerBase extends OnOffServerBase.with("Lighting") {
  override on() {
    // Set by every OnOff command that turns it on, as the spec asks.
    this.state.globalSceneControl = true;
    return super.on();
  }

  override onWithTimedOff({ onOffControl }: OnOff.OnWithTimedOffRequest) {
    // Turns on only from off. While on it would only restart the timer, which
    // plugs do not run, so HA gets nothing.
    if (onOffControl.acceptOnlyWhenOn || this.state.onOff) {
      return;
    }
    return this.on();
  }

  // matter.js would apply the stored global scene and then call on() as well,
  // so HA would get the on twice.
  override onWithRecallGlobalScene() {
    if (this.state.globalSceneControl) {
      return;
    }
    return this.on();
  }
}

export function PlugOnOffServer(config: OnOffConfig = {}) {
  return PlugOnOffServerBase.set({ config });
}

export function setOptimisticOnOff(entityId: string, expectedOnOff: boolean) {
  const now = Date.now();
  sweepOptimisticOnOff(now);
  optimisticOnOffState.set(entityId, {
    expectedOnOff,
    timestamp: now,
  });
}
