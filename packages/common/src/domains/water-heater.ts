/**
 * Water Heater operation modes from Home Assistant
 * https://www.home-assistant.io/integrations/water_heater/
 */
export enum WaterHeaterOperationMode {
  off = "off",
  eco = "eco",
  electric = "electric",
  gas = "gas",
  heat_pump = "heat_pump",
  high_demand = "high_demand",
  performance = "performance",
}

/**
 * Water Heater supported features bitmask
 * https://github.com/home-assistant/core/blob/dev/homeassistant/components/water_heater/const.py
 */
export enum WaterHeaterDeviceFeature {
  TARGET_TEMPERATURE = 1,
  OPERATION_MODE = 2,
  AWAY_MODE = 4,
  ON_OFF = 8,
}

export interface WaterHeaterDeviceAttributes {
  min_temp?: number | string | null | undefined;
  max_temp?: number | string | null | undefined;
  current_temperature?: number | string | null | undefined;
  temperature?: number | string | null | undefined;
  target_temp_high?: number | string | null | undefined;
  target_temp_low?: number | string | null | undefined;
  operation_mode?: string | null | undefined;
  operation_list?: string[] | null | undefined;
  away_mode?: "on" | "off" | null | undefined;
  supported_features?: number;
}
