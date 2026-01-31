import type {
  HomeAssistantEntityState,
  HumidiferDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { HumidityMeasurementServer } from "../../../../behaviors/humidity-measurement-server.js";

export const HumidifierHumidityMeasurementServer = HumidityMeasurementServer({
  getValue: (state: HomeAssistantEntityState) => {
    const { current_humidity } = state.attributes as HumidiferDeviceAttributes;
    return current_humidity ?? null;
  },
});
