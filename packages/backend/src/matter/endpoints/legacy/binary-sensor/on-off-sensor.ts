import { OnOffSensorDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";
import { PowerSourceServer } from "../../../behaviors/power-source-server.js";

const OnOffSensorServer = OnOffServer({
  turnOn: null,
  turnOff: null,
}).with();

export const OnOffSensorType = OnOffSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  OnOffSensorServer,
);

export const OnOffSensorWithBatteryType = OnOffSensorDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  OnOffSensorServer,
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
