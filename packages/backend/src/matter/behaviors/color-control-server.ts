import {
  ColorConverter,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { ColorControlServer as Base } from "@matter/main/behaviors/color-control";
import { ColorControl } from "@matter/main/clusters";
import type { ColorInstance } from "color";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("ColorControlServer");

// Track optimistic color writes to prevent stale HA state from overwriting them.
// Instead of a blanket cooldown, track expected values and only skip stale updates.
interface OptimisticColorState {
  colorTemperatureMireds?: number;
  currentHue?: number;
  currentSaturation?: number;
  timestamp: number;
}
const optimisticColorState = new Map<string, OptimisticColorState>();
const OPTIMISTIC_TIMEOUT_MS = 3000;
const OPTIMISTIC_TOLERANCE = 5;

// Pre-staged color data for Adaptive Lighting. When a controller adjusts
// color while the light is off (executeIfOff), the action is stored here
// instead of calling HA (which would turn the light on). The OnOff handler
// merges this into the turn-on action so the light comes on at the correct color.
const pendingColorStaging = new Map<string, object>();

export function consumePendingColorStaging(
  entityId: string,
): object | undefined {
  const data = pendingColorStaging.get(entityId);
  pendingColorStaging.delete(entityId);
  return data;
}

export type ColorControlMode =
  | ColorControl.ColorMode.CurrentHueAndCurrentSaturation
  | ColorControl.ColorMode.ColorTemperatureMireds;

export interface ColorControlConfig {
  getCurrentMode: ValueGetter<ColorControlMode | undefined>;
  getCurrentKelvin: ValueGetter<number | undefined>;
  getMinColorTempKelvin: ValueGetter<number | undefined>;
  getMaxColorTempKelvin: ValueGetter<number | undefined>;
  getColor: ValueGetter<ColorInstance | undefined>;

  setTemperature: ValueSetter<number>;
  setColor: ValueSetter<ColorInstance>;
}

const FeaturedBase = Base.with("ColorTemperature", "HueSaturation");

export class ColorControlServerBase extends FeaturedBase {
  declare state: ColorControlServerBase.State;
  private pendingTransitionTime: number | undefined;

  override async [Symbol.asyncDispose]() {
    const entityId = this.agent.get(HomeAssistantEntityBehavior).entityId;
    optimisticColorState.delete(entityId);
    pendingColorStaging.delete(entityId);
    await super[Symbol.asyncDispose]();
  }

  override async initialize() {
    // CRITICAL: Set default values BEFORE super.initialize() to prevent validation errors.
    // Matter.js validates ColorTemperature attributes during initialization.
    // If the light is OFF, all color values from HA are null, causing validation to fail
    // with "Behaviors have errors".
    if (this.features.colorTemperature) {
      // Default color temp range: 2000K - 6500K (147-500 mireds)
      const defaultMinMireds = 147; // ~6800K
      const defaultMaxMireds = 500; // ~2000K
      const defaultMireds = 250; // ~4000K (neutral white)

      if (
        this.state.colorTempPhysicalMinMireds == null ||
        this.state.colorTempPhysicalMinMireds === 0
      ) {
        this.state.colorTempPhysicalMinMireds = defaultMinMireds;
      }
      if (
        this.state.colorTempPhysicalMaxMireds == null ||
        this.state.colorTempPhysicalMaxMireds === 0
      ) {
        this.state.colorTempPhysicalMaxMireds = defaultMaxMireds;
      }
      if (this.state.colorTemperatureMireds == null) {
        this.state.colorTemperatureMireds = defaultMireds;
      }
      if (this.state.coupleColorTempToLevelMinMireds == null) {
        this.state.coupleColorTempToLevelMinMireds = defaultMinMireds;
      }
      if (this.state.startUpColorTemperatureMireds == null) {
        this.state.startUpColorTemperatureMireds = defaultMireds;
      }

      logger.debug(
        `initialize: set ColorTemperature defaults - min=${this.state.colorTempPhysicalMinMireds}, max=${this.state.colorTempPhysicalMaxMireds}, current=${this.state.colorTemperatureMireds}`,
      );
    }

    if (this.features.hueSaturation) {
      // Default hue/saturation to 0 (red, no saturation = white)
      if (this.state.currentHue == null) {
        this.state.currentHue = 0;
      }
      if (this.state.currentSaturation == null) {
        this.state.currentSaturation = 0;
      }
    }

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
    const currentKelvin = config.getCurrentKelvin(entity.state, this.agent);
    let minKelvin =
      config.getMinColorTempKelvin(entity.state, this.agent) ?? 1500;
    let maxKelvin =
      config.getMaxColorTempKelvin(entity.state, this.agent) ?? 8000;
    minKelvin = Math.min(
      minKelvin,
      maxKelvin,
      currentKelvin ?? Number.POSITIVE_INFINITY,
    );
    maxKelvin = Math.max(
      minKelvin,
      maxKelvin,
      currentKelvin ?? Number.NEGATIVE_INFINITY,
    );

    const color = config.getColor(entity.state, this.agent);
    const [hue, saturation] = color ? ColorConverter.toMatterHS(color) : [0, 0];

    const minMireds = Math.floor(
      ColorConverter.temperatureKelvinToMireds(maxKelvin),
    );
    const maxMireds = Math.ceil(
      ColorConverter.temperatureKelvinToMireds(minKelvin),
    );
    // Clamp startUpMireds to valid range
    let startUpMireds = ColorConverter.temperatureKelvinToMireds(
      currentKelvin ?? maxKelvin,
    );
    startUpMireds = Math.max(Math.min(startUpMireds, maxMireds), minMireds);

    let currentMireds: number | undefined;
    if (currentKelvin != null) {
      currentMireds = ColorConverter.temperatureKelvinToMireds(currentKelvin);
      currentMireds = Math.max(Math.min(currentMireds, maxMireds), minMireds);
    }

    const newColorMode = this.getColorModeFromFeatures(
      config.getCurrentMode(entity.state, this.agent),
    );

    // Protect optimistic color values from stale HA state updates.
    // Accept updates that confirm expected values; skip stale ones.
    const optimistic = optimisticColorState.get(entity.entity_id);
    let skipColorTemp = false;
    let skipHueSat = false;
    if (optimistic != null) {
      if (Date.now() - optimistic.timestamp > OPTIMISTIC_TIMEOUT_MS) {
        optimisticColorState.delete(entity.entity_id);
      } else {
        if (
          optimistic.colorTemperatureMireds != null &&
          currentMireds != null
        ) {
          if (
            Math.abs(currentMireds - optimistic.colorTemperatureMireds) <=
            OPTIMISTIC_TOLERANCE
          ) {
            optimisticColorState.delete(entity.entity_id);
          } else {
            skipColorTemp = true;
          }
        }
        if (
          optimistic.currentHue != null &&
          optimistic.currentSaturation != null
        ) {
          if (
            Math.abs(hue - optimistic.currentHue) <= OPTIMISTIC_TOLERANCE &&
            Math.abs(saturation - optimistic.currentSaturation) <=
              OPTIMISTIC_TOLERANCE
          ) {
            optimisticColorState.delete(entity.entity_id);
          } else {
            skipHueSat = true;
          }
        }
      }
    }

    // CRITICAL: For ColorTemperature, we must set boundaries FIRST, then values.
    // Matter.js validates that colorTemperatureMireds and startUpColorTemperatureMireds
    // are within [colorTempPhysicalMinMireds, colorTempPhysicalMaxMireds].
    // If we set values before boundaries, validation fails with "Behaviors have errors".
    if (this.features.colorTemperature) {
      // Step 0: Clamp existing colorTemperatureMireds to the new range BEFORE
      // updating boundaries. Without this, Matter.js validation fails when the
      // boundaries are tightened and the current value is outside the new range.
      // This happens e.g. when the default (250 mireds) is below the device's
      // actual minimum (e.g. 275 mireds for narrow-range CT lights like #92).
      const existingMireds = this.state.colorTemperatureMireds;
      if (existingMireds != null) {
        const clampedExisting = Math.max(
          Math.min(existingMireds, maxMireds),
          minMireds,
        );
        if (clampedExisting !== existingMireds) {
          applyPatchState(this.state, {
            colorTemperatureMireds: clampedExisting,
          });
        }
      }

      // Step 1: Set the physical boundaries
      applyPatchState(this.state, {
        colorTempPhysicalMinMireds: minMireds,
        colorTempPhysicalMaxMireds: maxMireds,
      });

      // Step 2: Now set the values that depend on those boundaries.
      // When the light is OFF (currentMireds is null), clamp colorTemperatureMireds
      // to the valid range to prevent it staying at an out-of-range default.
      const effectiveMireds =
        currentMireds ??
        Math.max(
          Math.min(this.state.colorTemperatureMireds ?? minMireds, maxMireds),
          minMireds,
        );
      applyPatchState(this.state, {
        coupleColorTempToLevelMinMireds: minMireds,
        startUpColorTemperatureMireds: startUpMireds,
        ...(skipColorTemp ? {} : { colorTemperatureMireds: effectiveMireds }),
      });
    }

    // Only publish colorMode alongside the cluster values that actually
    // changed this cycle. When hue/sat is skipped but CT isn't (or vice
    // versa), writing colorMode without its companion values produced a
    // mismatched snapshot that controllers read back inconsistently.
    const writingHueSat = this.features.hueSaturation && !skipHueSat;
    const writingColorTemp =
      !skipColorTemp &&
      newColorMode === ColorControl.ColorMode.ColorTemperatureMireds;
    const shouldPublishColorMode =
      (writingHueSat &&
        newColorMode !== ColorControl.ColorMode.ColorTemperatureMireds) ||
      writingColorTemp;
    applyPatchState(this.state, {
      ...(shouldPublishColorMode ? { colorMode: newColorMode } : {}),
      ...(writingHueSat
        ? {
            currentHue: hue,
            currentSaturation: saturation,
          }
        : {}),
    });
  }

  override moveToColorTemperature(
    request: ColorControl.MoveToColorTemperatureRequest,
  ) {
    this.pendingTransitionTime = request.transitionTime;
    return super.moveToColorTemperature(request);
  }

  override moveToColorTemperatureLogic(targetMireds: number) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const current = homeAssistant.entity.state;
    const currentKelvin = this.state.config.getCurrentKelvin(
      current,
      this.agent,
    );
    const targetKelvin = ColorConverter.temperatureMiredsToKelvin(targetMireds);
    if (targetKelvin == null) {
      // Matter allows colorTemperatureMireds = 0 in some contexts, but HA's
      // light.turn_on expects a finite kelvin/mireds value. Drop the command
      // rather than pass Infinity through.
      return;
    }

    if (currentKelvin === targetKelvin) {
      return;
    }

    const action = this.state.config.setTemperature(targetKelvin, this.agent);
    this.applyTransition(action);
    applyPatchState(this.state, {
      colorTemperatureMireds: targetMireds,
      colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
    });
    optimisticColorState.set(homeAssistant.entityId, {
      colorTemperatureMireds: targetMireds,
      timestamp: Date.now(),
    });

    if (this.isLightOff()) {
      pendingColorStaging.set(homeAssistant.entityId, action.data ?? {});
      return;
    }
    homeAssistant.callAction(action);
  }

  override moveToHueLogic(targetHue: number) {
    this.moveToHueAndSaturationLogic(targetHue, this.state.currentSaturation);
  }

  override moveToSaturationLogic(targetSaturation: number) {
    this.moveToHueAndSaturationLogic(this.state.currentHue, targetSaturation);
  }

  override moveToHueAndSaturation(
    request: ColorControl.MoveToHueAndSaturationRequest,
  ) {
    this.pendingTransitionTime = request.transitionTime;
    return super.moveToHueAndSaturation(request);
  }

  override moveToHueAndSaturationLogic(
    targetHue: number,
    targetSaturation: number,
  ) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const haColor = this.state.config.getColor(
      homeAssistant.entity.state,
      this.agent,
    );
    const [currentHue, currentSaturation] = haColor
      ? ColorConverter.toMatterHS(haColor)
      : [];
    if (currentHue === targetHue && currentSaturation === targetSaturation) {
      return;
    }
    const color = ColorConverter.fromMatterHS(targetHue, targetSaturation);
    const action = this.state.config.setColor(color, this.agent);
    this.applyTransition(action);
    applyPatchState(this.state, {
      currentHue: targetHue,
      currentSaturation: targetSaturation,
      colorMode: ColorControl.ColorMode.CurrentHueAndCurrentSaturation,
    });
    optimisticColorState.set(homeAssistant.entityId, {
      currentHue: targetHue,
      currentSaturation: targetSaturation,
      timestamp: Date.now(),
    });

    if (this.isLightOff()) {
      pendingColorStaging.set(homeAssistant.entityId, action.data ?? {});
      return;
    }
    homeAssistant.callAction(action);
  }

  private isLightOff(): boolean {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    return homeAssistant.entity.state.state === "off";
  }

  private applyTransition(action: { data?: object }) {
    const tenths = this.pendingTransitionTime;
    this.pendingTransitionTime = undefined;
    if (tenths && tenths > 0) {
      action.data = { ...action.data, transition: tenths / 10 };
    }
  }

  private getColorModeFromFeatures(mode: ColorControlMode | undefined) {
    // This cluster is only used with HueSaturation, ColorTemperature or Both.
    // It is never used without any of them.
    if (this.features.colorTemperature && this.features.hueSaturation) {
      return mode ?? ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    }
    if (this.features.colorTemperature) {
      return ColorControl.ColorMode.ColorTemperatureMireds;
    }
    if (this.features.hueSaturation) {
      return ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    }
    throw new Error(
      "ColorControlServer does not support either HueSaturation or ColorTemperature",
    );
  }
}

export namespace ColorControlServerBase {
  export class State extends FeaturedBase.State {
    config!: ColorControlConfig;
  }
}

export function ColorControlServer(config: ColorControlConfig) {
  return ColorControlServerBase.set({
    options: { executeIfOff: true },
    config,
  });
}
