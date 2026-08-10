import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { ActionContext } from "@matter/main";
import {
  FanControlServer as Base,
  OnOffBehavior,
} from "@matter/main/behaviors";
import { FanControl } from "@matter/main/clusters";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import {
  FanMode,
  fanModeSequenceFor,
} from "../../utils/converters/fan-mode.js";
import {
  percentToPresetIndex,
  toAscendingSpeedPresets,
} from "../../utils/converters/fan-mode-order.js";
import { FanSpeed } from "../../utils/converters/fan-speed.js";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";
import { FanSpeedMemoryBehavior } from "./fan-speed-memory.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { setOptimisticOnOff } from "./on-off-server.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import AirflowDirection = FanControl.AirflowDirection;

const logger = Logger.get("FanControlServer");

const defaultStepSize = 33.33;
const minSpeedMax = 3;
const maxSpeedMax = 100;

export interface FanControlRockSetting {
  rockLeftRight?: boolean;
  rockUpDown?: boolean;
  rockRound?: boolean;
}

// Inbound speed-write debounce (#443).
//
// Controllers stream percentSetting while the user is still dragging: a single
// Google Home fan-slider drag was measured emitting nine writes in eight
// seconds. Every write becomes a Home Assistant service call, and on IR/UART
// bridged air conditioners every call is a device frame the unit beeps at.
//
// Covers already solve this (window-covering-server.ts, coverSliderDebounceMs).
// This is the fan-domain equivalent, deliberately simpler: one window, and off
// by default so behaviour is unchanged unless a user opts in.
//
// Keyed by the persistent endpoint, not held on the behavior: matter.js runs
// each command on a throwaway instance, so an instance field would never see
// the previous write's timer. The pending entry holds plain values only, the
// agent context expires when the command handler returns (#411).
interface FanPendingAction {
  action: HomeAssistantAction;
  entityId: string;
  actions: HomeAssistantActions;
}

interface FanDebounceState {
  timer: ReturnType<typeof setTimeout> | null;
  pending: FanPendingAction | null;
}

const fanDebounce = new WeakMap<object, FanDebounceState>();

function getFanDebounce(endpoint: object): FanDebounceState {
  let st = fanDebounce.get(endpoint);
  if (!st) {
    st = { timer: null, pending: null };
    fanDebounce.set(endpoint, st);
  }
  return st;
}

function clearFanDebounce(st: FanDebounceState) {
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }
  st.pending = null;
}

// Auto is deliberately NOT part of the shared base. Matter forbids the
// non-auto FanModeSequence values while the AUT feature is present, so an
// entity without an auto mode must not declare the feature at all - otherwise
// controllers keep offering an "Auto" Home Assistant cannot honour.
const FeaturedBase = Base.with(
  "Step",
  "MultiSpeed",
  "AirflowDirection",
  "Rocking",
  "Wind",
).set({
  windSupport: { naturalWind: true, sleepWind: true },
});

export interface FanControlServerConfig {
  getPercentage: ValueGetter<number | undefined>;
  getStepSize: ValueGetter<number | undefined>;
  getAirflowDirection: ValueGetter<AirflowDirection | undefined>;
  isInAutoMode: ValueGetter<boolean>;
  // Preset mode support for fans without percentage control
  getPresetModes: ValueGetter<string[] | undefined>;
  getCurrentPresetMode: ValueGetter<string | undefined>;
  supportsPercentage: ValueGetter<boolean>;
  // Rocking (oscillation) support
  isOscillating: ValueGetter<boolean>;
  supportsOscillation: ValueGetter<boolean>;
  getRockSetting?: ValueGetter<FanControlRockSetting>;
  // Wind mode support - returns preset mode name that maps to wind
  getWindMode: ValueGetter<"natural" | "sleep" | undefined>;
  supportsWind: ValueGetter<boolean>;
  // Which wind modes the entity actually offers. Defaults to both when the
  // domain does not implement it, preserving the previous behaviour.
  getWindSupport?: ValueGetter<{ naturalWind: boolean; sleepWind: boolean }>;

  turnOff: ValueSetter<void>;
  /**
   * Whether speed zero should also drive the OnOff cluster off.
   *
   * True for a standalone fan: no speed IS off. FALSE for an air conditioner,
   * whose fan cannot stop independently of the compressor - there, speed zero
   * means "slowest", and flipping OnOff would tell the controller the whole
   * unit had powered down while it kept running, so the tile flaps off and
   * back on. Power belongs to the OnOff cluster's own commands. Defaults to
   * true.
   */
  syncOnOffWithSpeed?: boolean;
  turnOn: ValueSetter<number>;
  setAutoMode: ValueSetter<void>;
  setAirflowDirection: ValueSetter<AirflowDirection>;
  // Set preset mode for fans without percentage control
  setPresetMode: ValueSetter<string>;
  // Rocking (oscillation) control
  setOscillation: ValueSetter<boolean>;
  setRockSetting?: ValueSetter<FanControlRockSetting>;
  // Wind mode control - sets preset mode for wind
  setWindMode: ValueSetter<"natural" | "sleep" | "off">;
}

export class FanControlServerBase extends FeaturedBase {
  declare state: FanControlServerBase.State;

  // Fallback last-speed tracking for endpoints without FanSpeedMemoryBehavior
  // (climate companion, humidifier). matter.js builds behavior instances per
  // transaction, so these fields only live within one interaction; fans use
  // the persisted memory behavior instead (#225/#387).
  private lastNonZeroPercent = 0;
  private lastNonZeroSpeed = 0;
  private lastIsAutoMode = false;

  // Remembered speed, read at decision time. Behavior state survives
  // transactions and restarts, instance fields do not (#387).
  private remembered(): { percent: number; speed: number; auto: boolean } {
    if (this.agent.has(FanSpeedMemoryBehavior)) {
      const s = this.agent.get(FanSpeedMemoryBehavior).state;
      return { percent: s.lastPercent, speed: s.lastSpeed, auto: s.lastAuto };
    }
    return {
      percent: this.lastNonZeroPercent,
      speed: this.lastNonZeroSpeed,
      auto: this.lastIsAutoMode,
    };
  }

  override async [Symbol.asyncDispose]() {
    // this.endpoint is valid on the dispose instance, so this clears the real
    // timer held in the registry.
    const st = fanDebounce.get(this.endpoint);
    if (st) {
      clearFanDebounce(st);
      fanDebounce.delete(this.endpoint);
    }
    await super[Symbol.asyncDispose]();
  }

  override async initialize() {
    // fanModeSequence is mandatory and has no model default, so it is still
    // unset when update() bails out on an entity without state or attributes,
    // and matter.js then fails conformance with "you must set this attribute".
    // The seed must match the AUT feature: Matter rejects the non-auto
    // sequences while Auto is present, and the auto ones while it is absent.
    if (this.state.fanModeSequence == null) {
      this.state.fanModeSequence = this.features.auto
        ? FanControl.FanModeSequence.OffLowMedHighAuto
        : FanControl.FanModeSequence.OffLowMedHigh;
    }
    // Matter.js defaults: speedMax=0, percentSetting=null, percentCurrent=0
    // speedMax=0 is invalid for MultiSpeed feature - must be >= 1 per Matter spec
    if (this.features.multiSpeed) {
      if (this.state.speedMax == null || this.state.speedMax < minSpeedMax) {
        this.state.speedMax = minSpeedMax;
      }
    }
    // Other values (percentSetting=null, percentCurrent=0) are valid per Matter spec

    await super.initialize();

    // Seed last non-zero values from persisted state so turn-on after
    // a bridge restart can restore the previous speed.
    const ps = this.state.percentSetting;
    if (ps != null && ps > 0) {
      this.lastNonZeroPercent = ps;
    }
    if (this.features.multiSpeed) {
      const ss = this.state.speedSetting;
      if (ss != null && ss > 0) {
        this.lastNonZeroSpeed = ss;
      }
    }
    // Migrate the percentSetting seed into the persisted memory once, so
    // fans that were on at shutdown keep their speed known (#387).
    if (this.agent.has(FanSpeedMemoryBehavior)) {
      const memory = await this.agent.load(FanSpeedMemoryBehavior);
      if (memory.state.lastPercent === 0 && this.lastNonZeroPercent > 0) {
        memory.state.lastPercent = this.lastNonZeroPercent;
        memory.state.lastSpeed = this.lastNonZeroSpeed;
      }
    }

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
    this.reactTo(
      this.events.percentSetting$Changed,
      this.targetPercentSettingChanged,
    );
    this.reactTo(this.events.fanMode$Changed, this.targetFanModeChanged);
    if (this.features.multiSpeed) {
      this.reactTo(
        this.events.speedSetting$Changed,
        this.targetSpeedSettingChanged,
      );
    }
    if (this.features.airflowDirection) {
      this.reactTo(
        this.events.airflowDirection$Changed,
        this.targetAirflowDirectionChanged,
      );
    }
    if (this.features.rocking) {
      this.reactTo(
        this.events.rockSetting$Changed,
        this.targetRockSettingChanged,
      );
    }
    if (this.features.wind) {
      this.reactTo(
        this.events.windSetting$Changed,
        this.targetWindSettingChanged,
      );
    }
    // Cross-cluster: restore fan speed on controller-initiated turn-on
    // to prevent Apple Home defaulting to 100% (#225).
    if (this.agent.has(OnOffBehavior)) {
      this.reactTo(
        this.agent.get(OnOffBehavior).events.onOff$Changed,
        this.onOffChanged,
      );
    }
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const config = this.state.config;
    const supportsPercentage = config.supportsPercentage(
      entity.state,
      this.agent,
    );
    const presetModes = config.getPresetModes(entity.state, this.agent) ?? [];
    const currentPresetMode = config.getCurrentPresetMode(
      entity.state,
      this.agent,
    );

    let percentage: number;
    let speedMax: number;
    let speed: number;

    if (supportsPercentage) {
      // Fan supports percentage control - use percentage-based logic
      percentage = config.getPercentage(entity.state, this.agent) ?? 0;
      const stepSize = config.getStepSize(entity.state, this.agent);
      const effectiveStepSize =
        stepSize != null && stepSize > 0 ? stepSize : defaultStepSize;
      const calculatedSpeedMax = Math.round(100 / effectiveStepSize);
      speedMax = Math.max(
        minSpeedMax,
        Math.min(maxSpeedMax, calculatedSpeedMax),
      );
      speed =
        percentage === 0
          ? 0
          : Math.max(1, Math.ceil(speedMax * (percentage / 100)));
    } else {
      // Fan only supports preset modes - map presets to speeds
      // Filter out "Auto" as it's handled separately
      const speedPresets = toAscendingSpeedPresets(
        presetModes.filter((m) => m.toLowerCase() !== "auto"),
      );
      // Preset-driven fans expose exactly as many speeds as Home Assistant
      // declares. Padding invents speeds the entity cannot accept, which
      // controllers then offer to the user. An auto-only preset list still
      // reports one speed, Matter requires SpeedMax >= 1.
      speedMax = Math.max(1, Math.min(maxSpeedMax, speedPresets.length));

      // Map current preset to speed level
      if (entity.state.state === "off" || !currentPresetMode) {
        speed = 0;
        percentage = 0;
      } else if (currentPresetMode.toLowerCase() === "auto") {
        // Auto mode - keep current speed or default to middle
        speed = Math.ceil(speedMax / 2);
        percentage = Math.floor((speed / speedMax) * 100);
      } else {
        const presetIndex = speedPresets.findIndex(
          (m) => m.toLowerCase() === currentPresetMode.toLowerCase(),
        );
        // Map preset index to speed (1-based, 0 = off)
        speed = presetIndex >= 0 ? presetIndex + 1 : 1;
        percentage = Math.floor((speed / speedMax) * 100);
      }
    }

    // Always set percentSetting and speedSetting: when the fan is off they
    // MUST be 0. Retaining a non-zero percentSetting while onOff=false
    // causes Apple Home to stay on "Turning off..." indefinitely (#219).
    const isOff = percentage === 0;

    const fanModeSequence = this.getFanModeSequence(speedMax);
    // When the fan is off, fanMode MUST be Off regardless of preset_mode.
    // HA fans (especially Dyson) keep preset_mode="Auto" even when off;
    // setting fanMode=Auto + onOff=false causes Apple Home to show
    // "Turning off..." indefinitely (#219).
    const fanMode =
      !isOff && config.isInAutoMode(entity.state, this.agent)
        ? FanMode.create(FanControl.FanMode.Auto, fanModeSequence)
        : FanMode.fromSpeedPercent(percentage, fanModeSequence);

    // Save last non-zero values; restored on controller-initiated turn-on
    // to prevent Apple Home defaulting to 100% (#225).
    if (percentage > 0) {
      this.lastNonZeroPercent = percentage;
      this.lastNonZeroSpeed = speed;
      this.lastIsAutoMode = config.isInAutoMode(entity.state, this.agent);
      this.persistSpeed(this.lastIsAutoMode);
    }

    try {
      applyPatchState(this.state, {
        percentSetting: isOff ? 0 : percentage,
        percentCurrent: percentage,
        fanMode: fanMode.mode,
        fanModeSequence: fanModeSequence,

        ...(this.features.multiSpeed
          ? {
              speedMax: speedMax,
              speedSetting: isOff ? 0 : speed,
              speedCurrent: speed,
            }
          : {}),

        ...(this.features.airflowDirection
          ? {
              airflowDirection: config.getAirflowDirection(
                entity.state,
                this.agent,
              ),
            }
          : {}),

        ...(this.features.rocking
          ? {
              rockSetting: config.getRockSetting
                ? config.getRockSetting(entity.state, this.agent)
                : {
                    rockUpDown: config.isOscillating(entity.state, this.agent),
                  },
            }
          : {}),

        ...(this.features.wind
          ? {
              windSupport: config.getWindSupport
                ? config.getWindSupport(entity.state, this.agent)
                : { naturalWind: true, sleepWind: true },
              windSetting: this.mapWindModeToSetting(
                config.getWindMode(entity.state, this.agent),
              ),
            }
          : {}),
      });
    } catch {
      // Ignore transaction conflicts during post-commit phase
      // The state will be updated on the next entity update
    }
  }

  override step(request: FanControl.StepRequest) {
    const fanSpeed = new FanSpeed(this.state.speedCurrent, this.state.speedMax);
    const newSpeed = fanSpeed.step(request).currentSpeed;
    const percentSetting = Math.floor((newSpeed / this.state.speedMax) * 100);

    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return;
    }
    this.syncOnOffFromSpeed(percentSetting !== 0);
    if (percentSetting === 0) {
      homeAssistant.callAction(this.state.config.turnOff(void 0, this.agent));
    } else {
      const stepSize = this.state.config.getStepSize(
        homeAssistant.entity.state,
        this.agent,
      );
      const roundedPercentage =
        stepSize && stepSize > 0
          ? Math.round(percentSetting / stepSize) * stepSize
          : percentSetting;
      const clampedPercentage = Math.max(
        stepSize ?? 1,
        Math.min(100, roundedPercentage),
      );
      homeAssistant.callAction(
        this.state.config.turnOn(clampedPercentage, this.agent),
      );
      this.rememberSpeed(clampedPercentage);
    }
  }

  private targetSpeedSettingChanged(
    speed: number | null,
    _oldValue?: number | null,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    if (speed == null) {
      return;
    }
    // When a controller writes percentSetting, matter.js auto-derives
    // speedSetting. If the derivation floors to 0 while percentSetting is
    // still non-zero, skip, the percentSetting handler already applied the
    // correct rounded action (#275).
    if (speed === 0 && (this.state.percentSetting ?? 0) > 0) {
      return;
    }
    this.agent.asLocalActor(() => {
      const percentage = Math.floor((speed / this.state.speedMax) * 100);
      this.applyPercentageAction(percentage);
    });
  }

  private targetFanModeChanged(
    fanMode: FanControl.FanMode,
    _oldValue: FanControl.FanMode,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (!homeAssistant.isAvailable) {
        return;
      }
      const targetFanMode = FanMode.create(fanMode, this.state.fanModeSequence);
      if (targetFanMode.mode === FanControl.FanMode.Auto) {
        this.syncOnOffFromSpeed(true);
        homeAssistant.callAction(
          this.state.config.setAutoMode(void 0, this.agent),
        );
      } else {
        this.applyPercentageAction(targetFanMode.speedPercent());
      }
    });
  }

  private targetPercentSettingChanged(
    percentage: number | null,
    _oldValue?: number | null,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    if (percentage == null) {
      return;
    }
    this.agent.asLocalActor(() => {
      this.applyPercentageAction(percentage);
    });
  }

  // Per-entity override wins over the per-bridge flag; both must be > 0 to
  // count. Mirrors WindowCoveringServerBase.resolveDebounceOverride.
  private resolveFanDebounceMs(
    homeAssistant: HomeAssistantEntityBehavior,
  ): number | null {
    const fromEntity = homeAssistant.state.mapping?.fanSliderDebounceMs;
    if (typeof fromEntity === "number" && fromEntity > 0) {
      return fromEntity;
    }
    const fromBridge =
      this.env.get(BridgeDataProvider).featureFlags?.fanSliderDebounceMs;
    if (typeof fromBridge === "number" && fromBridge > 0) {
      return fromBridge;
    }
    return null;
  }

  // Send a speed-derived action, or park it in the debounce window so only the
  // last write of a burst reaches HA. Cluster state was already updated per
  // write, so the controller sees immediate feedback either way. With no
  // window configured this is a plain callAction, the historic path.
  private dispatchSpeedAction(
    homeAssistant: HomeAssistantEntityBehavior,
    action: HomeAssistantAction,
  ) {
    const debounceMs = this.resolveFanDebounceMs(homeAssistant);
    if (debounceMs == null) {
      homeAssistant.callAction(action);
      return;
    }
    // Capture plain values now, the deferred dispatch runs outside any
    // transaction, the same way the cover debounce fires (#411).
    const entityId = homeAssistant.entityId;
    const actions = this.env.get(HomeAssistantActions);
    const st = getFanDebounce(this.endpoint);
    st.pending = { action, entityId, actions };
    // The registry lives on the persistent endpoint, so this clears the
    // previous write's live timer and only the last pending action fires.
    if (st.timer) {
      clearTimeout(st.timer);
    }
    st.timer = setTimeout(() => {
      st.timer = null;
      const pending = st.pending;
      st.pending = null;
      if (pending) {
        pending.actions.call(pending.action, pending.entityId);
      }
    }, debounceMs);
  }

  // Devices whose fan cannot stop (air conditioners) opt out of driving OnOff
  // from speed: speed zero is a speed change, not a power change (#442).
  private syncOnOffFromSpeed(on: boolean) {
    if (this.state.config.syncOnOffWithSpeed !== false) {
      this.syncOnOff(on);
    }
  }

  private applyPercentageAction(percentage: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return;
    }
    // Opt-in: a controller writing a speed while the fan is off is a power-on
    // injection (Apple Home power button). Restore the last speed instead (#387).
    const restoreOnPowerOn =
      homeAssistant.state.mapping?.fanRestoreSpeedOnPowerOn === true;
    // Live onOff races: Apple sends onOff.on in a separate frame that can flip
    // it true before this reactor runs, so also trust the HA state, still off
    // here because turn_on hasn't been sent yet (#387).
    const wasOff =
      homeAssistant.entity.state?.state === "off" ||
      (this.agent.has(OnOffBehavior) &&
        !this.agent.get(OnOffBehavior).state.onOff);
    const remembered = this.remembered();
    if (wasOff) {
      // Log the power-on decision so a stuck-at-100 report is unambiguous (#387).
      logger.debug(
        `[${homeAssistant.entityId}] power-on write ${percentage}%: restore flag=${restoreOnPowerOn}, last speed=${remembered.percent}`,
      );
    }
    // Only the controller's injected 100% default gets replaced. A lower
    // value while off is a deliberate speed choice and passes through.
    if (
      restoreOnPowerOn &&
      wasOff &&
      remembered.percent > 0 &&
      percentage >= 100
    ) {
      percentage = remembered.percent;
      // Reflect it in the cluster too, else Apple's injected 100 stays and a
      // later sync pushes it back over the restore (#387).
      try {
        applyPatchState(this.state, {
          percentSetting: remembered.percent,
          percentCurrent: remembered.percent,
          ...(this.features.multiSpeed && remembered.speed > 0
            ? {
                speedSetting: remembered.speed,
                speedCurrent: remembered.speed,
              }
            : {}),
        });
      } catch {
        // Transaction conflict, HA echo will set the correct values
      }
    }
    const config = this.state.config;
    const supportsPercentage = config.supportsPercentage(
      homeAssistant.entity.state,
      this.agent,
    );

    this.syncOnOffFromSpeed(percentage !== 0);
    if (percentage === 0) {
      this.dispatchSpeedAction(
        homeAssistant,
        config.turnOff(void 0, this.agent),
      );
    } else if (supportsPercentage) {
      const stepSize = config.getStepSize(
        homeAssistant.entity.state,
        this.agent,
      );
      const roundedPercentage =
        stepSize && stepSize > 0
          ? Math.round(percentage / stepSize) * stepSize
          : percentage;
      const clampedPercentage = Math.max(
        stepSize ?? 1,
        Math.min(100, roundedPercentage),
      );

      this.dispatchSpeedAction(
        homeAssistant,
        config.turnOn(clampedPercentage, this.agent),
      );
      this.rememberSpeed(clampedPercentage);
    } else {
      const presetModes =
        config.getPresetModes(homeAssistant.entity.state, this.agent) ?? [];
      const speedPresets = toAscendingSpeedPresets(
        presetModes.filter((m) => m.toLowerCase() !== "auto"),
      );

      if (speedPresets.length > 0) {
        const presetIndex = percentToPresetIndex(
          percentage,
          speedPresets.length,
        );
        const targetPreset = speedPresets[presetIndex];
        this.dispatchSpeedAction(
          homeAssistant,
          config.setPresetMode(targetPreset, this.agent),
        );
        this.rememberSpeed(percentage);
      }
    }
  }

  // Controller writes count as the last speed too. Some integrations
  // (ha_xiaomi_home) accept fan.set_percentage but never report a percentage
  // attribute, so capturing only HA updates misses them (#387).
  private rememberSpeed(percentage: number) {
    if (percentage <= 0) {
      return;
    }
    this.lastNonZeroPercent = percentage;
    const speedMax = this.state.speedMax ?? 0;
    if (this.features.multiSpeed && speedMax > 0) {
      this.lastNonZeroSpeed = Math.max(
        1,
        Math.ceil(speedMax * (percentage / 100)),
      );
    }
    // A manual speed write leaves auto mode. Safe to persist here: the
    // memory behavior only exists on fan endpoints, so humidifier percent
    // writes (humidity setpoints) never reach it.
    this.persistSpeed(false);
  }

  // Write the remembered speed through to the memory behavior. Instance
  // fields die with the transaction, this is what later interactions and
  // restarts read (#387).
  private persistSpeed(auto?: boolean) {
    if (!this.agent.has(FanSpeedMemoryBehavior)) {
      return;
    }
    try {
      applyPatchState(this.agent.get(FanSpeedMemoryBehavior).state, {
        lastPercent: this.lastNonZeroPercent,
        lastSpeed: this.lastNonZeroSpeed,
        ...(auto !== undefined ? { lastAuto: auto } : {}),
      });
    } catch {
      // Transaction conflict, a later write will persist it
    }
  }

  private targetAirflowDirectionChanged(
    airflowDirection: AirflowDirection,
    _oldValue: AirflowDirection,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    // Use asLocalActor to avoid access control issues when accessing state
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (!homeAssistant.isAvailable) {
        return;
      }

      const config = this.state.config;
      homeAssistant.callAction(
        config.setAirflowDirection(airflowDirection, this.agent),
      );
    });
  }

  private getFanModeSequence(speedCount?: number) {
    // The sequence family must agree with the compiled AUT feature or Matter
    // rejects the value, so it derives from features.auto alone. Endpoints
    // decide that feature from the entity's presets via autoPresetName.
    const auto = this.features.auto;
    if (!this.features.multiSpeed) {
      return auto
        ? FanControl.FanModeSequence.OffHighAuto
        : FanControl.FanModeSequence.OffHigh;
    }
    return fanModeSequenceFor(speedCount, auto);
  }

  private targetRockSettingChanged(
    rockSetting: FanControlRockSetting,
    _oldValue: FanControlRockSetting,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (!homeAssistant.isAvailable) {
        return;
      }
      const config = this.state.config;
      homeAssistant.callAction(
        config.setRockSetting
          ? config.setRockSetting(rockSetting, this.agent)
          : config.setOscillation(!!rockSetting.rockUpDown, this.agent),
      );
    });
  }

  private targetWindSettingChanged(
    windSetting: { sleepWind?: boolean; naturalWind?: boolean },
    _oldValue: { sleepWind?: boolean; naturalWind?: boolean },
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    this.agent.asLocalActor(() => {
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (!homeAssistant.isAvailable) {
        return;
      }
      let mode: "natural" | "sleep" | "off" = "off";
      if (windSetting.naturalWind) {
        mode = "natural";
      } else if (windSetting.sleepWind) {
        mode = "sleep";
      }
      homeAssistant.callAction(this.state.config.setWindMode(mode, this.agent));
    });
  }

  // Cross-cluster: restore fan speed on controller-initiated turn-on.
  // When a controller sends OnOff.on() and percentSetting is 0, Apple Home
  // may default to 100%. Restoring the last non-zero value avoids this (#225).
  private onOffChanged(
    onOff: boolean,
    _oldValue: boolean,
    context?: ActionContext,
  ) {
    if (transactionIsOffline(context)) {
      return;
    }
    const remembered = this.remembered();
    if (onOff && remembered.percent > 0) {
      // Use asLocalActor so the percentSetting change is treated as offline.
      // Without this, targetPercentSettingChanged fires and sends a second
      // fan.turn_on(percentage), overriding the no-param fan.turn_on from
      // OnOffServer.on(), which causes Auto→Manual mode regression (#219).
      this.agent.asLocalActor(() => {
        try {
          applyPatchState(this.state, {
            percentSetting: remembered.percent,
            ...(this.features.multiSpeed && remembered.speed > 0
              ? { speedSetting: remembered.speed }
              : {}),
          });
        } catch {
          // Transaction conflict, HA state update will set correct values
        }
      });
      // Also tell HA to turn on at the remembered speed so the fan doesn't
      // fall back to 100% when a plain OnOff.on() is used (#275).
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (homeAssistant.isAvailable) {
        if (remembered.auto) {
          homeAssistant.callAction(
            this.state.config.setAutoMode(void 0, this.agent),
          );
        } else {
          homeAssistant.callAction(
            this.state.config.turnOn(remembered.percent, this.agent),
          );
        }
      }
    }
  }

  // Cross-cluster sync: keep OnOff in sync with FanControl per Matter spec
  // §4.4.6.6.1. matter.js does not implement this automatically.
  private syncOnOff(on: boolean) {
    try {
      if (!this.agent.has(OnOffBehavior)) return;
      const onOffState = this.agent.get(OnOffBehavior).state;
      applyPatchState(onOffState, { onOff: on });
      const entityId = this.agent.get(HomeAssistantEntityBehavior).entity
        .entity_id;
      setOptimisticOnOff(entityId, on);
    } catch (e) {
      logger.debug(
        `syncOnOff(${on}) failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private mapWindModeToSetting(mode: "natural" | "sleep" | undefined): {
    naturalWind?: boolean;
    sleepWind?: boolean;
  } {
    return {
      naturalWind: mode === "natural",
      sleepWind: mode === "sleep",
    };
  }
}

export namespace FanControlServerBase {
  export class State extends FeaturedBase.State {
    config!: FanControlServerConfig;
  }
}

const FanControlServerWithAuto = FanControlServerBase.with("Auto");

export function FanControlServer(
  config: FanControlServerConfig,
  defaults: { rockSupport?: FanControlRockSetting; auto?: boolean } = {},
) {
  // Default stays "auto supported" so existing endpoints are unchanged.
  const base =
    defaults.auto === false ? FanControlServerBase : FanControlServerWithAuto;
  return base.set({
    config,
    rockSupport: defaults.rockSupport ?? { rockUpDown: true },
  });
}
