export interface HumidiferDeviceAttributes {
  min_humidity: number;
  max_humidity: number;
  current_humidity: number;
  humidity: number;
  available_modes?: string[];
  mode?: string;
}
