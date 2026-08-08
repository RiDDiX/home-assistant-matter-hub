export enum LawnMowerActivity {
  error = "error",
  paused = "paused",
  mowing = "mowing",
  docked = "docked",
  returning = "returning",
}

export enum LawnMowerEntityFeature {
  START_MOWING = 1,
  PAUSE = 2,
  DOCK = 4,
}

export interface LawnMowerDeviceAttributes {
  supported_features?: number;
  // Most robotic mowers expose battery via a sibling sensor entity, but some
  // surface it on the mower entity. Read both like the vacuum domain does.
  battery_level?: number | string | null | undefined;
  battery?: number | string | null | undefined;
}
