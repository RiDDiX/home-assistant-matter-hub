import type {
  HomeAssistantEntityInformation,
  WaterHeaterDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { WaterHeaterOperationMode } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import {
  WaterHeaterManagementServer as Base,
  ThermostatBehavior,
} from "@matter/main/behaviors";
import { WaterHeaterManagement } from "@matter/main/clusters";
import { StatusCode, StatusResponseError } from "@matter/main/types";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { Temperature } from "../../../../../utils/converters/temperature.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  activeHeatSource,
  normalizeOperationMode,
  type WaterHeaterModeMapping,
} from "../water-heater-modes.js";
import { WaterHeaterBoostMemoryBehavior } from "./water-heater-boost-memory.js";

const logger = Logger.get("WaterHeaterManagementServer");

/** setTimeout truncates delays beyond ~24.8 days to 32 bit and fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * What a running Boost has to undo when it ends.
 *
 * matter.js runs every command on a throwaway proxy instance, so instance
 * fields do not survive to a later timer callback. The session is keyed on the
 * persistent Endpoint object instead (the EVSE charge-window precedent).
 */
interface BoostSession {
  timer?: ReturnType<typeof setTimeout>;
  /** HA operation mode the entity was in before the boost. */
  previousOperationMode?: string;
  /** Target temperature in HA units to restore, when boost overrode it. */
  restoreTemperature?: number;
  /** Boost target in HA units, used for the OneShot cut-off. */
  boostTarget?: number;
  oneShot: boolean;
  /**
   * HA confirms set_operation_mode asynchronously, so the first state events
   * after Boost may still carry the pre-boost mode. Only once the entity has
   * been seen in the boost mode does a different mode mean an external cancel.
   */
  observedInBoostMode: boolean;
}

const boostSessions = new WeakMap<object, BoostSession>();

function clearBoostTimer(endpoint: object) {
  const session = boostSessions.get(endpoint);
  if (session?.timer) {
    clearTimeout(session.timer);
    session.timer = undefined;
  }
}

function numeric(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && !Number.isNaN(parsed)
    ? parsed
    : undefined;
}

/**
 * WaterHeaterManagement (0x0094, Matter 1.4) on top of a Home Assistant
 * water_heater entity.
 *
 * Boost switches the entity to its fastest heating operation mode (high_demand,
 * else performance, else plain turn_on) for the requested duration and restores
 * the previous mode and setpoint when the boost ends — whether that is through
 * CancelBoost, the duration expiring, the OneShot cut-off, or the user changing
 * the mode in Home Assistant.
 *
 * The EnergyManagement and TankPercent features stay off: Home Assistant
 * exposes neither tank volume nor a hot-water level, so TankVolume,
 * EstimatedHeatRequired and TankPercentage could only be invented.
 */
// biome-ignore lint/correctness/noUnusedVariables: used by the factory below
class WaterHeaterManagementServerBase extends Base {
  declare state: WaterHeaterManagementServerBase.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    await this.resumeBoostAfterRestart();
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  /**
   * Pick a boost that spanned a bridge restart back up from the persisted
   * memory. A OneShot boost and an expired one end right here with the usual
   * restore, a still-running one gets its session and timer back.
   */
  private async resumeBoostAfterRestart() {
    const memory = (await this.agent.load(WaterHeaterBoostMemoryBehavior))
      .state;
    if (!memory.active || boostSessions.has(this.endpoint)) {
      return;
    }
    const session: BoostSession = {
      // Whether a OneShot target was reached during the downtime is
      // unknowable, so a OneShot boost always ends with the restart.
      oneShot: false,
      previousOperationMode: memory.previousOperationMode || undefined,
      restoreTemperature: memory.hasRestoreTemperature
        ? memory.restoreTemperature
        : undefined,
      // The pre-restart run already saw HA confirm the boost mode.
      observedInBoostMode: true,
    };
    boostSessions.set(this.endpoint, session);

    const expired = memory.expiresAt > 0 && memory.expiresAt <= Date.now();
    if (memory.oneShot || expired) {
      this.endBoost({ restoreMode: true });
      return;
    }

    applyPatchState(this.state, {
      boostState: WaterHeaterManagement.BoostState.Active,
    });
    if (memory.expiresAt > 0) {
      this.armBoostTimer((memory.expiresAt - Date.now()) / 1000);
    }
  }

  override async [Symbol.asyncDispose]() {
    clearBoostTimer(this.endpoint);
    await super[Symbol.asyncDispose]();
  }

  private get attributes(): WaterHeaterDeviceAttributes {
    return this.agent.get(HomeAssistantEntityBehavior).entity.state
      .attributes as WaterHeaterDeviceAttributes;
  }

  private get unit(): string {
    return this.agent.env.get(HomeAssistantConfig).unitSystem.temperature;
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const attributes = entity.state.attributes as WaterHeaterDeviceAttributes;
    const isOff =
      normalizeOperationMode(entity.state.state) ===
        WaterHeaterOperationMode.off ||
      (attributes.operation_mode != null &&
        normalizeOperationMode(attributes.operation_mode) ===
          WaterHeaterOperationMode.off);

    const session = boostSessions.get(this.endpoint);
    const boosting =
      this.state.boostState === WaterHeaterManagement.BoostState.Active;

    if (boosting && session) {
      // The boost ends when Home Assistant leaves the boost mode behind our
      // back, and — for a OneShot boost — once the water is up to temperature.
      // HA confirms set_operation_mode asynchronously though, so events that
      // still carry the pre-boost mode do not count until the entity has been
      // seen in the boost mode once.
      // boostOperationMode keeps operation_list's casing, state updates may
      // report the mode differently ("High Demand" vs "high_demand").
      const boostMode = this.state.mapping.boostOperationMode;
      const inBoostMode =
        !isOff &&
        (boostMode == null ||
          (attributes.operation_mode != null &&
            normalizeOperationMode(attributes.operation_mode) ===
              normalizeOperationMode(boostMode)));
      if (inBoostMode) {
        session.observedInBoostMode = true;
      }
      const leftBoostMode = session.observedInBoostMode && !inBoostMode;
      const current = numeric(attributes.current_temperature);
      const target = session.boostTarget ?? numeric(attributes.temperature);
      const reachedTarget =
        session.oneShot &&
        current != null &&
        target != null &&
        current >= target;

      if (leftBoostMode || reachedTarget) {
        this.endBoost({ restoreMode: reachedTarget });
        return;
      }
    }

    const heating =
      !isOff &&
      (() => {
        const current = numeric(attributes.current_temperature);
        const target = numeric(attributes.temperature);
        if (current == null || target == null) {
          // Nothing to compare, a running heater is assumed to be heating.
          return true;
        }
        return current < target;
      })();

    // HeaterTypes has quality F (fixed) and is seeded at endpoint construction,
    // so only HeatDemand is patched here.
    applyPatchState(this.state, {
      heatDemand: heating ? activeHeatSource(attributes) : {},
    });
  }

  override boost(request: WaterHeaterManagement.BoostRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const attributes = this.attributes;
    const info = request.boostInfo;

    // TargetPercentage and TargetReheat are conformant only under the
    // TankPercent feature, which this server does not support. The spec and the
    // reference implementation both reject the command rather than ignore the
    // fields (connectedhomeip water-heater-management-server.cpp).
    if (info.targetPercentage != null || info.targetReheat != null) {
      throw new StatusResponseError(
        "TargetPercentage and TargetReheat require the TankPercent feature",
        StatusCode.InvalidCommand,
      );
    }
    if (info.temporarySetpoint != null) {
      this.assertSetpointInRange(info.temporarySetpoint);
    }

    // A fresh Boost supersedes a running one, but must not overwrite the
    // pre-boost mode we still owe a restore to. Teardown only after the
    // request validated: a rejected Boost must leave the running one, and
    // above all its expiry timer, untouched.
    const running = boostSessions.get(this.endpoint);
    clearBoostTimer(this.endpoint);

    const session: BoostSession = {
      oneShot: info.oneShot === true,
      previousOperationMode:
        running?.previousOperationMode ??
        attributes.operation_mode ??
        undefined,
      restoreTemperature: running?.restoreTemperature,
      observedInBoostMode: false,
    };

    const actions: HomeAssistantAction[] = [];
    const boostMode = this.state.mapping.boostOperationMode;
    if (boostMode != null) {
      actions.push({
        action: "water_heater.set_operation_mode",
        data: { operation_mode: boostMode },
      });
    } else {
      // No fast mode offered, the best a Boost can do is make sure it runs.
      actions.push({ action: "water_heater.turn_on", data: {} });
    }

    if (info.temporarySetpoint != null) {
      const temperature = Temperature.celsius(info.temporarySetpoint / 100);
      if (temperature) {
        const value = temperature.toUnit(this.unit);
        session.boostTarget = value;
        session.restoreTemperature =
          running?.restoreTemperature ?? numeric(attributes.temperature);
        actions.push({
          action: "water_heater.set_temperature",
          data: { temperature: value },
        });
      }
    } else {
      session.boostTarget = numeric(attributes.temperature);
    }

    boostSessions.set(this.endpoint, session);
    this.saveBoostMemory(session, info.duration);
    for (const action of actions) {
      homeAssistant.callAction(action);
    }

    applyPatchState(this.state, {
      boostState: WaterHeaterManagement.BoostState.Active,
      heatDemand: activeHeatSource(attributes),
    });
    this.events.boostStarted.emit({ boostInfo: info }, this.context);

    this.armBoostTimer(info.duration);
  }

  /**
   * TemporarySetpoint shall be within MinHeatSetpointLimit and
   * MaxHeatSetpointLimit of the thermostat cluster, inclusive. Those limits are
   * what this endpoint advertises from the entity's min_temp / max_temp, so a
   * value outside them would be a temperature the water heater never offered.
   */
  private assertSetpointInRange(temporarySetpoint: number) {
    let min: number | undefined;
    let max: number | undefined;
    try {
      // The Heating feature is mandatory on this device type, but the base
      // behavior's state type does not carry the feature-gated attributes.
      const thermostat = this.agent.get(ThermostatBehavior).state as {
        minHeatSetpointLimit?: number;
        maxHeatSetpointLimit?: number;
      };
      min = thermostat.minHeatSetpointLimit;
      max = thermostat.maxHeatSetpointLimit;
    } catch {
      // No thermostat on this endpoint, nothing to validate against.
      return;
    }
    if (
      (min != null && temporarySetpoint < min) ||
      (max != null && temporarySetpoint > max)
    ) {
      throw new StatusResponseError(
        `TemporarySetpoint ${temporarySetpoint} outside the heat setpoint limits ${min}..${max}`,
        StatusCode.ConstraintError,
      );
    }
  }

  override cancelBoost() {
    if (
      this.state.boostState === WaterHeaterManagement.BoostState.Inactive &&
      !boostSessions.has(this.endpoint)
    ) {
      return;
    }
    this.endBoost({ restoreMode: true });
  }

  /**
   * Stop the boost and put the entity back the way it was.
   *
   * restoreMode: false skips only the operation-mode restore, for the case
   * where HA itself already moved the entity off the boost mode and
   * re-applying the old mode would fight the user. The temporary setpoint
   * override is ours in every case and always goes back.
   */
  private endBoost(options: { restoreMode: boolean }) {
    clearBoostTimer(this.endpoint);
    const session = boostSessions.get(this.endpoint);
    boostSessions.delete(this.endpoint);

    if (session) {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (session.restoreTemperature != null) {
        homeAssistant.callAction({
          action: "water_heater.set_temperature",
          data: { temperature: session.restoreTemperature },
        });
      }
      if (options.restoreMode && session.previousOperationMode != null) {
        homeAssistant.callAction({
          action: "water_heater.set_operation_mode",
          data: { operation_mode: session.previousOperationMode },
        });
      }
    }

    this.clearBoostMemory();
    applyPatchState(this.state, {
      boostState: WaterHeaterManagement.BoostState.Inactive,
    });
    this.events.boostEnded.emit(undefined, this.context);
  }

  /** Mirror the restore data into quality N state, see resumeBoostAfterRestart. */
  private saveBoostMemory(session: BoostSession, durationSeconds: number) {
    const delay = durationSeconds * 1000;
    const bounded =
      Number.isFinite(delay) && delay > 0 && delay <= MAX_TIMER_MS;
    applyPatchState(this.agent.get(WaterHeaterBoostMemoryBehavior).state, {
      active: true,
      previousOperationMode: session.previousOperationMode ?? "",
      hasRestoreTemperature: session.restoreTemperature != null,
      restoreTemperature: session.restoreTemperature ?? 0,
      expiresAt: bounded ? Date.now() + delay : 0,
      oneShot: session.oneShot,
    });
  }

  private clearBoostMemory() {
    applyPatchState(this.agent.get(WaterHeaterBoostMemoryBehavior).state, {
      active: false,
      previousOperationMode: "",
      hasRestoreTemperature: false,
      restoreTemperature: 0,
      expiresAt: 0,
      oneShot: false,
    });
  }

  /** Auto-cancel once the requested boost duration is up. */
  private armBoostTimer(durationSeconds: number) {
    const delay = durationSeconds * 1000;
    if (!Number.isFinite(delay) || delay <= 0 || delay > MAX_TIMER_MS) {
      logger.debug(
        `Boost duration ${durationSeconds}s outside the timer range, boost stays active until CancelBoost`,
      );
      return;
    }
    const endpoint = this.endpoint;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Only the current owner may fire, a fresh Boost replaces the timer.
          if (boostSessions.get(endpoint)?.timer !== timer) return;
          await endpoint.act((agent) => {
            agent
              .get(WaterHeaterManagementServerBase)
              .endBoost({ restoreMode: true });
          });
        } catch (error) {
          logger.debug(
            `Boost expiry failed (endpoint may be closing): ${error}`,
          );
        }
      })();
    }, delay);
    // A safety net must not keep the event loop alive on its own.
    (timer as { unref?: () => void }).unref?.();
    const session = boostSessions.get(endpoint);
    if (session) {
      session.timer = timer;
    }
  }
}

namespace WaterHeaterManagementServerBase {
  export class State extends Base.State {
    mapping!: WaterHeaterModeMapping;
  }
}

export function WaterHeaterManagementServer(
  mapping: WaterHeaterModeMapping,
  sources: WaterHeaterManagement.WaterHeaterHeatSource,
) {
  return WaterHeaterManagementServerBase.set({
    mapping,
    // heaterTypes, heatDemand and boostState are mandatory and have no
    // defaults, an unseeded endpoint fails to mount. heaterTypes additionally
    // has quality F, so it is set here once and never patched at runtime.
    heaterTypes: sources,
    heatDemand: {},
    boostState: WaterHeaterManagement.BoostState.Inactive,
  });
}
