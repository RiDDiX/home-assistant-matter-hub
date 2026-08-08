import { BooleanStateConfigurationServer } from "@matter/main/behaviors";
import { ContactSensorDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { BooleanStateServer } from "../../../behaviors/boolean-state-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../behaviors/power-source-server.js";

export const ContactSensorType = ContactSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  BooleanStateServer({ inverted: true }),
  BooleanStateConfigurationServer,
);

// 1.3-safe ContactSensor (0x15) for leak/freeze/rain detectors. Their dedicated
// WaterLeak/WaterFreeze/Rain device types are Matter 1.4 and Alexa (1.3) rejects
// them, which breaks the whole-bridge subscription (#365). Same device type as
// ContactSensorType but NON-inverted, so a detected alarm (HA "on") still
// reports stateValue true.
export const DetectorContactSensorType = ContactSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  BooleanStateServer(),
  BooleanStateConfigurationServer,
);

export const ContactSensorWithBatteryType = ContactSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  BooleanStateServer({ inverted: true }),
  BooleanStateConfigurationServer,
  PowerSourceServer({
    getBatteryPercent: (entity, agent) => {
      // First check for battery entity from mapping (auto-assigned or manual)
      const homeAssistant = agent.get(HomeAssistantEntityBehavior);
      const batteryEntity = homeAssistant.state.mapping?.batteryEntity;
      if (batteryEntity) {
        const stateProvider = agent.env.get(EntityStateProvider);
        const battery = stateProvider.getBatteryPercent(batteryEntity);
        if (battery != null) {
          return Math.max(0, Math.min(100, battery));
        }
      }

      // Fallback to entity's own battery attribute
      const attrs = entity.attributes as {
        battery?: number;
        battery_level?: number;
      };
      const level = attrs.battery_level ?? attrs.battery;
      if (level == null || Number.isNaN(Number(level))) {
        return null;
      }
      return Number(level);
    },
  }),
);
