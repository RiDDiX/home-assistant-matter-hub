import { VacuumDeviceFeature } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const logger = Logger.get("VacuumIdentifyServer");

export class VacuumIdentifyServer extends IdentifyServer {
  protected override identifyInHomeAssistant(source: string) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const features =
      homeAssistant.entity.state.attributes.supported_features ?? 0;
    if (testBit(features, VacuumDeviceFeature.LOCATE)) {
      logger.info(`${source} → vacuum.locate for ${homeAssistant.entityId}`);
      homeAssistant.callAction({ action: "vacuum.locate" });
      return;
    }
    // No LOCATE bit. Some integrations (e.g. UWANT, Xiaomi MIOT) expose locate
    // as a sibling button entity instead, so try the shared lookup first.
    if (this.findIdentifyEntity(homeAssistant)) {
      super.identifyInHomeAssistant(source);
      return;
    }
    // Dreame and friends support vacuum.locate without setting the bit (#208).
    logger.warn(
      `${source} for ${homeAssistant.entityId}, LOCATE not in supported_features (${features}), trying vacuum.locate anyway`,
    );
    homeAssistant.callAction({ action: "vacuum.locate" });
  }
}
