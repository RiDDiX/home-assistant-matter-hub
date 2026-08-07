import { FanControl } from "@matter/main/clusters";

export class FanMode {
  public static create(
    mode: FanControl.FanMode,
    sequence: FanControl.FanModeSequence,
  ) {
    let currentMode: FanControl.FanMode;
    if (mode === FanControl.FanMode.On) {
      currentMode = FanControl.FanMode.High;
    } else if (mode === FanControl.FanMode.Smart) {
      currentMode = FanControl.FanMode.Auto;
    } else {
      currentMode = mode;
    }
    if (currentMode === FanControl.FanMode.Auto && !_autoSupported(sequence)) {
      currentMode = FanControl.FanMode.High;
    }
    return new FanMode(currentMode, sequence);
  }

  public static fromSpeedPercent(
    percentage: number,
    sequence: FanControl.FanModeSequence,
  ) {
    if (percentage === 0) {
      return FanMode.create(FanControl.FanMode.Off, sequence);
    }
    const fanModes = _fanModesForSequence(sequence);
    const modeIndex = Math.ceil((percentage / 100) * fanModes.length) - 1;
    const mode = fanModes[modeIndex];
    return FanMode.create(mode, sequence);
  }

  private constructor(
    public readonly mode:
      | FanControl.FanMode.Off
      | FanControl.FanMode.Low
      | FanControl.FanMode.Medium
      | FanControl.FanMode.High
      | FanControl.FanMode.Auto,
    public readonly sequence: FanControl.FanModeSequence,
  ) {}

  speedPercent() {
    if (this.mode === FanControl.FanMode.Off) {
      return 0;
    }
    if (this.mode === FanControl.FanMode.Auto) {
      return 100;
    }
    const sequence = _fanModesForSequence(this.sequence);
    let index = sequence.indexOf(this.mode);
    if (index === -1) {
      index = 0;
    }
    const percent = (index + 1) / sequence.length;
    return percent * 100;
  }

  equals(other: FanMode) {
    return this.mode === other.mode && this.sequence === other.sequence;
  }
}

/**
 * Get the list of supported fan modes (without auto and off) based on the fan mode sequence
 * @param sequence The fan mode sequence of the fan.
 */
function _fanModesForSequence(
  sequence: FanControl.FanModeSequence,
): FanControl.FanMode[] {
  switch (sequence) {
    case FanControl.FanModeSequence.OffLowMedHigh:
    case FanControl.FanModeSequence.OffLowMedHighAuto:
      return [
        FanControl.FanMode.Low,
        FanControl.FanMode.Medium,
        FanControl.FanMode.High,
      ];
    case FanControl.FanModeSequence.OffLowHigh:
    case FanControl.FanModeSequence.OffLowHighAuto:
      return [FanControl.FanMode.Low, FanControl.FanMode.High];
    case FanControl.FanModeSequence.OffHigh:
    case FanControl.FanModeSequence.OffHighAuto:
      return [FanControl.FanMode.High];
  }
}

/**
 * Check if the current fan mode sequence supports auto mode
 * @param sequence
 */
function _autoSupported(sequence: FanControl.FanModeSequence): boolean {
  switch (sequence) {
    case FanControl.FanModeSequence.OffLowMedHighAuto:
    case FanControl.FanModeSequence.OffLowHighAuto:
    case FanControl.FanModeSequence.OffHighAuto:
      return true;
    case FanControl.FanModeSequence.OffLowMedHigh:
    case FanControl.FanModeSequence.OffLowHigh:
    case FanControl.FanModeSequence.OffHigh:
      return false;
  }
}

/**
 * The entity's auto preset, if it really has one. Exact case-insensitive match
 * only: a preset like "Automatic" or "Auto Comfort" cannot be commanded by
 * sending "auto", so it must not count as Auto support. Every place that
 * decides Auto (feature gates, sequence, commands) goes through this so they
 * cannot disagree; a featureMap/sequence mismatch is a conformance error.
 */
export function autoPresetName(
  presetModes: string[] | undefined,
): string | undefined {
  return presetModes?.find((mode) => mode.toLowerCase() === "auto");
}

/**
 * Pick the FanModeSequence that matches how many speeds the entity actually
 * exposes. Home Assistant entities frequently offer fewer than three speeds
 * (a climate with fan_modes ["low","high"], a fan with a single preset), and
 * advertising OffLowMedHigh for those makes controllers show speeds the entity
 * will reject.
 *
 * @param speedCount number of selectable speeds, excluding off/auto
 * @param auto whether the entity supports an auto mode
 */
export function fanModeSequenceFor(
  speedCount: number | undefined,
  auto: boolean,
): FanControl.FanModeSequence {
  if (speedCount != null && speedCount <= 1) {
    return auto
      ? FanControl.FanModeSequence.OffHighAuto
      : FanControl.FanModeSequence.OffHigh;
  }
  if (speedCount === 2) {
    return auto
      ? FanControl.FanModeSequence.OffLowHighAuto
      : FanControl.FanModeSequence.OffLowHigh;
  }
  return auto
    ? FanControl.FanModeSequence.OffLowMedHighAuto
    : FanControl.FanModeSequence.OffLowMedHigh;
}
