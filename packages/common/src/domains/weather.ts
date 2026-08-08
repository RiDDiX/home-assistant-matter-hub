// https://www.home-assistant.io/integrations/weather/
// https://developers.home-assistant.io/docs/core/entity/weather
// The websocket API exposes the non-native attribute keys (the native_*
// variants are Python-only). A weather entity's state is the textual condition
// (e.g. "sunny"), so all numeric readings come from attributes. Humidity and
// pressure are optional; not every weather integration provides them.
export interface WeatherEntityAttributes {
  temperature?: number;
  temperature_unit?: string;
  humidity?: number;
  pressure?: number;
  pressure_unit?: string;
}
