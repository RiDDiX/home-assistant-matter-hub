import { RvcOperationalState } from "@matter/main/clusters";

const { ErrorState } = RvcOperationalState;

// Use standard RVC fault codes and keep the precise cause in errorStateDetails
// (64 UTF-8 bytes). Labels are reserved for manufacturer-specific codes.
const ROBOROCK_ERRORS: Record<
  string,
  readonly [RvcOperationalState.ErrorState, string]
> = {
  lidar_blocked: [ErrorState.NavigationSensorObscured, "Lidar blocked"],
  bumper_stuck: [ErrorState.Stuck, "Bumper stuck"],
  wheels_suspended: [ErrorState.Stuck, "Wheels suspended"],
  cliff_sensor_error: [
    ErrorState.NavigationSensorObscured,
    "Cliff sensor error",
  ],
  main_brush_jammed: [ErrorState.BrushJammed, "Main brush jammed"],
  side_brush_jammed: [ErrorState.BrushJammed, "Side brush jammed"],
  wheels_jammed: [ErrorState.WheelsJammed, "Wheels jammed"],
  robot_trapped: [ErrorState.Stuck, "Robot trapped"],
  no_dustbin: [ErrorState.DustBinMissing, "Dust bin missing"],
  strainer_error: [ErrorState.UnableToCompleteOperation, "Filter error"],
  compass_error: [ErrorState.UnableToCompleteOperation, "Compass error"],
  low_battery: [ErrorState.LowBattery, "Battery too low"],
  charging_error: [ErrorState.UnableToCompleteOperation, "Charging error"],
  battery_error: [ErrorState.UnableToCompleteOperation, "Battery error"],
  wall_sensor_dirty: [ErrorState.NavigationSensorObscured, "Wall sensor dirty"],
  robot_tilted: [ErrorState.Stuck, "Robot tilted"],
  side_brush_error: [ErrorState.UnableToCompleteOperation, "Side brush error"],
  fan_error: [ErrorState.UnableToCompleteOperation, "Fan error"],
  dock: [ErrorState.UnableToCompleteOperation, "Dock error"],
  optical_flow_sensor_dirt: [
    ErrorState.NavigationSensorObscured,
    "Optical flow sensor dirty",
  ],
  vertical_bumper_pressed: [ErrorState.Stuck, "Vertical bumper pressed"],
  dock_locator_error: [
    ErrorState.UnableToCompleteOperation,
    "Dock locator error",
  ],
  return_to_dock_fail: [
    ErrorState.FailedToFindChargingDock,
    "Failed to find charging dock",
  ],
  nogo_zone_detected: [ErrorState.Stuck, "No-go zone detected"],
  visual_sensor: [ErrorState.NavigationSensorObscured, "Visual sensor error"],
  light_touch: [ErrorState.Stuck, "Touch sensor error"],
  vibrarise_jammed: [ErrorState.UnableToCompleteOperation, "Mop module jammed"],
  robot_on_carpet: [ErrorState.Stuck, "Robot on unsuitable carpet"],
  filter_blocked: [ErrorState.UnableToCompleteOperation, "Filter blocked"],
  invisible_wall_detected: [ErrorState.Stuck, "Invisible wall detected"],
  cannot_cross_carpet: [ErrorState.Stuck, "Cannot cross carpet"],
  internal_error: [
    ErrorState.UnableToCompleteOperation,
    "Internal robot error",
  ],
  collect_dust_error_3: [
    ErrorState.UnableToCompleteOperation,
    "Dock needs cleaning",
  ],
  collect_dust_error_4: [
    ErrorState.UnableToCompleteOperation,
    "Dock voltage error",
  ],
  mopping_roller_1: [
    ErrorState.UnableToCompleteOperation,
    "Dock wash roller jammed",
  ],
  mopping_roller_error_2: [
    ErrorState.UnableToCompleteOperation,
    "Dock wash roller not lowered",
  ],
  clear_water_box_hoare: [
    ErrorState.UnableToCompleteOperation,
    "Check clean water tank",
  ],
  dirty_water_box_hoare: [
    ErrorState.UnableToCompleteOperation,
    "Check dirty water tank",
  ],
  sink_strainer_hoare: [
    ErrorState.UnableToCompleteOperation,
    "Dock water filter missing",
  ],
  clear_water_box_exception: [
    ErrorState.WaterTankEmpty,
    "Clean water tank empty",
  ],
  clear_brush_exception: [
    ErrorState.UnableToCompleteOperation,
    "Check dock water filter",
  ],
  clear_brush_exception_2: [
    ErrorState.UnableToCompleteOperation,
    "Dock positioning button error",
  ],
  filter_screen_exception: [
    ErrorState.UnableToCompleteOperation,
    "Clean dock water filter",
  ],
  mopping_roller_2: [
    ErrorState.UnableToCompleteOperation,
    "Dock wash roller jammed",
  ],
  up_water_exception: [
    ErrorState.UnableToCompleteOperation,
    "Dock water filling error",
  ],
  drain_water_exception: [
    ErrorState.UnableToCompleteOperation,
    "Dock water draining error",
  ],
  temperature_protection: [
    ErrorState.UnableToCompleteOperation,
    "Temperature protection",
  ],
  clean_carousel_exception: [
    ErrorState.UnableToCompleteOperation,
    "Dock wash tray error",
  ],
  clean_carousel_water_full: [
    ErrorState.UnableToCompleteOperation,
    "Dock wash tray water full",
  ],
  water_carriage_drop: [
    ErrorState.UnableToCompleteOperation,
    "Water carriage dropped",
  ],
  check_clean_carouse: [
    ErrorState.UnableToCompleteOperation,
    "Check dock wash tray",
  ],
  audio_error: [ErrorState.UnableToCompleteOperation, "Audio error"],
};

export function mapVacuumOperationalError(
  state: string,
  fault?: string,
  hasFaultSource = false,
): RvcOperationalState.ErrorStateStruct {
  // A returning vacuum with a low battery, expired consumables, optional mop
  // hardware, or an offline vacuum must not become a fabricated Stuck error.
  if (state !== "error") return { errorStateId: ErrorState.NoError };
  if (!hasFaultSource) {
    return { errorStateId: ErrorState.Stuck, errorStateDetails: "Stuck" };
  }
  const entry =
    fault && Object.hasOwn(ROBOROCK_ERRORS, fault)
      ? ROBOROCK_ERRORS[fault]
      : undefined;
  return entry
    ? {
        errorStateId: entry[0],
        errorStateDetails: `${entry[1]} [${fault}]`,
      }
    : {
        errorStateId: ErrorState.UnableToCompleteOperation,
        errorStateDetails: "Vacuum operational error",
      };
}
