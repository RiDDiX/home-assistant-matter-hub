import { BatteryStorageDevice } from "@matter/main/devices";
import { numericState } from "../../../../../utils/numeric-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";

export const BatterySensorType = BatteryStorageDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  PowerSourceServer({
    getBatteryPercent(entity) {
      return numericState(entity.state);
    },
  }),
);
