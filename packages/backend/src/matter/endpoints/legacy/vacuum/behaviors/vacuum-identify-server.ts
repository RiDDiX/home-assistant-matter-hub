import { VacuumDeviceFeature } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Identify } from "@matter/main/clusters";
import { HomeAssistantRegistry } from "../../../../../services/home-assistant/home-assistant-registry.js";
import { testBit } from "../../../../../utils/test-bit.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

const logger = Logger.get("VacuumIdentifyServer");

const IDENTIFY_BUTTON_SUFFIXES = ["_identify", "_locate", "_find_me"];

export class VacuumIdentifyServer extends IdentifyServer {
  override triggerEffect(effect: Identify.TriggerEffectRequest) {
    this.#locate("triggerEffect");
    return super.triggerEffect(effect);
  }

  override identify(request: Identify.IdentifyRequest) {
    if (request.identifyTime > 0) {
      this.#locate("identify");
    }
    return super.identify(request);
  }

  #locate(source: string) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const features =
      homeAssistant.entity.state.attributes.supported_features ?? 0;
    if (testBit(features, VacuumDeviceFeature.LOCATE)) {
      logger.info(`${source} → vacuum.locate for ${homeAssistant.entityId}`);
      homeAssistant.callAction({ action: "vacuum.locate" });
      return;
    }
    // No LOCATE bit. Some integrations (e.g. UWANT, Xiaomi MIOT) expose locate
    // as a sibling button entity instead of via vacuum.locate; press that
    // when present. Otherwise fall back to vacuum.locate for integrations
    // like Dreame that support it without setting the bit (#208).
    const sibling = this.#findIdentifyButton(homeAssistant);
    if (sibling) {
      logger.info(
        `${source} → button.press ${sibling} for ${homeAssistant.entityId}`,
      );
      homeAssistant.callAction({ action: "button.press", target: sibling });
      return;
    }
    logger.warn(
      `${source} for ${homeAssistant.entityId}, LOCATE not in supported_features (${features}), trying vacuum.locate anyway`,
    );
    homeAssistant.callAction({ action: "vacuum.locate" });
  }

  #findIdentifyButton(
    homeAssistant: HomeAssistantEntityBehavior,
  ): string | undefined {
    const deviceId = homeAssistant.entity.registry?.device_id;
    if (!deviceId) return undefined;
    const registry = this.env.get(HomeAssistantRegistry);
    for (const entity of Object.values(registry.entities)) {
      if (entity.device_id !== deviceId) continue;
      if (!entity.entity_id.startsWith("button.")) continue;
      const uniqueId = entity.unique_id ?? "";
      if (
        IDENTIFY_BUTTON_SUFFIXES.some(
          (s) => entity.entity_id.endsWith(s) || uniqueId.endsWith(s),
        )
      ) {
        return entity.entity_id;
      }
    }
    return undefined;
  }
}
