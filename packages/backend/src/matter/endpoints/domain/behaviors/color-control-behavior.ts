import { ColorControlServer as Base } from "@matter/main/behaviors";
import { ColorControl } from "@matter/main/clusters";
import { applyPatchState } from "../../../../utils/apply-patch-state.js";
import {
  LightCommands,
  notifyEndpoint,
} from "../../../behaviors/callback-behavior.js";

const FeaturedBase = Base.with("HueSaturation", "ColorTemperature");

/**
 * Vision 1 ColorControlBehavior - Callback-based behavior.
 */
export class ColorControlBehavior extends FeaturedBase {
  declare state: ColorControlBehavior.State;

  override async initialize() {
    this.state.colorMode =
      ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
    this.state.options = { executeIfOff: false };
    this.state.numberOfPrimaries = 0;
    this.state.enhancedColorMode =
      ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation;
    this.state.colorCapabilities = {
      hueSaturation: true,
      enhancedHue: false,
      colorLoop: false,
      xy: false,
      colorTemperature: true,
    };
    this.state.currentHue = 0;
    this.state.currentSaturation = 0;
    this.state.colorTemperatureMireds = 370;
    this.state.colorTempPhysicalMinMireds = 153;
    this.state.colorTempPhysicalMaxMireds = 500;
    this.state.coupleColorTempToLevelMinMireds = 153;
    this.state.startUpColorTemperatureMireds = 370;
    await super.initialize();
  }

  /**
   * Called by the parent endpoint to update behavior state.
   */
  public updateFromEndpoint(update: {
    currentHue?: number;
    currentSaturation?: number;
    colorTemperatureMireds?: number;
    colorTempPhysicalMinMireds?: number;
    colorTempPhysicalMaxMireds?: number;
  }): void {
    applyPatchState(this.state, update);
  }

  override moveToHueAndSaturation(
    request: ColorControl.MoveToHueAndSaturationRequest,
  ): void {
    notifyEndpoint(this, "ColorControl", LightCommands.SET_COLOR, {
      hue: request.hue,
      saturation: request.saturation,
    });
  }

  override moveToColorTemperature(
    request: ColorControl.MoveToColorTemperatureRequest,
  ): void {
    notifyEndpoint(this, "ColorControl", LightCommands.SET_COLOR_TEMPERATURE, {
      colorTemperatureMireds: request.colorTemperatureMireds,
    });
  }
}

export namespace ColorControlBehavior {
  export class State extends FeaturedBase.State {}
}
