import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { ActionContext } from "@matter/main";
import {
  FanControlServer as Base,
  OnOffBehavior,
} from "@matter/main/behaviors";
import { FanControl } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { FanMode } from "../../utils/converters/fan-mode.js";
import { FanSpeed } from "../../utils/converters/fan-speed.js";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { setOptimisticOnOff } from "./on-off-server.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

import AirflowDirection = FanControl.AirflowDirection;
import Rock = FanControl.Rock;
import Wind = FanControl.Wind;

const logger = Logger.get("FanControlServer");

const defaultStepSize = 33.33;
const minSpeedMax = 3;
const maxSpeedMax = 100;

const FeaturedBase = Base.with(
  "Step",
  "MultiSpeed",
  "AirflowDirection",
  "Auto",
  "Rocking",
  "Wind",
).set({
  // rockSupport / windSupport are Fixed quality attributes — they MUST be set
  // via .set() at behavior creation time, NOT in initialize().
  // Without these, controllers reject attempts to enable rocking/wind.
  rockSupport: { rockUpDown: true },
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
  // Wind mode support - returns preset mode name that maps to wind
  getWindMode: ValueGetter<"natural" | "sleep" | undefined>;
  supportsWind: ValueGetter<boolean>;

  turnOff: ValueSetter<void>;
  turnOn: ValueSetter<number>;
  setAutoMode: ValueSetter<void>;
  setAirflowDirection: ValueSetter<AirflowDirection>;
  // Set preset mode for fans without percentage control
  setPresetMode: ValueSetter<string>;
  // Rocking (oscillation) control
  setOscillation: ValueSetter<boolean>;
  // Wind mode control - sets preset mode for wind
  setWindMode: ValueSetter<"natural" | "sleep" | "off">;
}

export class FanControlServerBase extends FeaturedBase {
  declare state: FanControlServerBase.State;

  // Track last non-zero fan speed for restore on turn-on (#225)
  private lastNonZeroPercent = 0;
  private lastNonZeroSpeed = 0;
  private lastIsAutoMode = false;

  override async initialize() {
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
    if (!entity.state?.attributes) {
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
      const speedPresets = presetModes.filter(
        (m) => m.toLowerCase() !== "auto",
      );
      speedMax = Math.max(
        minSpeedMax,
        Math.min(maxSpeedMax, speedPresets.length),
      );

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

    const fanModeSequence = this.getFanModeSequence();
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
              // rockUpDown maps to HA oscillating
              rockSetting: {
                rockUpDown: config.isOscillating(entity.state, this.agent),
              },
            }
          : {}),

        ...(this.features.wind
          ? {
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
    this.syncOnOff(percentSetting !== 0);
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
    // still non-zero, skip — the percentSetting handler already applied the
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
        this.syncOnOff(true);
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

  private applyPercentageAction(percentage: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    if (!homeAssistant.isAvailable) {
      return;
    }
    const config = this.state.config;
    const supportsPercentage = config.supportsPercentage(
      homeAssistant.entity.state,
      this.agent,
    );

    this.syncOnOff(percentage !== 0);
    if (percentage === 0) {
      homeAssistant.callAction(config.turnOff(void 0, this.agent));
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

      homeAssistant.callAction(config.turnOn(clampedPercentage, this.agent));
    } else {
      const presetModes =
        config.getPresetModes(homeAssistant.entity.state, this.agent) ?? [];
      const speedPresets = presetModes.filter(
        (m) => m.toLowerCase() !== "auto",
      );

      if (speedPresets.length > 0) {
        const presetIndex = Math.min(
          Math.floor((percentage / 100) * speedPresets.length),
          speedPresets.length - 1,
        );
        const targetPreset = speedPresets[presetIndex];
        homeAssistant.callAction(
          config.setPresetMode(targetPreset, this.agent),
        );
      }
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

  private getFanModeSequence() {
    if (this.features.multiSpeed) {
      return this.features.auto
        ? FanControl.FanModeSequence.OffLowMedHighAuto
        : FanControl.FanModeSequence.OffLowMedHigh;
    }
    return this.features.auto
      ? FanControl.FanModeSequence.OffHighAuto
      : FanControl.FanModeSequence.OffHigh;
  }

  private targetRockSettingChanged(
    rockSetting: {
      rockLeftRight?: boolean;
      rockUpDown?: boolean;
      rockRound?: boolean;
    },
    _oldValue: {
      rockLeftRight?: boolean;
      rockUpDown?: boolean;
      rockRound?: boolean;
    },
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
      // rockUpDown maps to HA oscillating
      const isOscillating = !!rockSetting.rockUpDown;
      homeAssistant.callAction(
        this.state.config.setOscillation(isOscillating, this.agent),
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
    if (onOff && this.lastNonZeroPercent > 0) {
      // Use asLocalActor so the percentSetting change is treated as offline.
      // Without this, targetPercentSettingChanged fires and sends a second
      // fan.turn_on(percentage), overriding the no-param fan.turn_on from
      // OnOffServer.on() — which causes Auto→Manual mode regression (#219).
      this.agent.asLocalActor(() => {
        try {
          applyPatchState(this.state, {
            percentSetting: this.lastNonZeroPercent,
            ...(this.features.multiSpeed && this.lastNonZeroSpeed > 0
              ? { speedSetting: this.lastNonZeroSpeed }
              : {}),
          });
        } catch {
          // Transaction conflict — HA state update will set correct values
        }
      });
      // Also tell HA to turn on at the remembered speed so the fan doesn't
      // fall back to 100% when a plain OnOff.on() is used (#275).
      const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
      if (homeAssistant.isAvailable) {
        if (this.lastIsAutoMode) {
          homeAssistant.callAction(
            this.state.config.setAutoMode(void 0, this.agent),
          );
        } else {
          homeAssistant.callAction(
            this.state.config.turnOn(this.lastNonZeroPercent, this.agent),
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

export function FanControlServer(config: FanControlServerConfig) {
  return FanControlServerBase.set({ config });
}
