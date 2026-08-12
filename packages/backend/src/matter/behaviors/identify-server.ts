import { Logger } from "@matter/general";
import { IdentifyServer as Base } from "@matter/main/behaviors";
import { Identify } from "@matter/main/clusters";
import { HomeAssistantRegistry } from "../../services/home-assistant/home-assistant-registry.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("IdentifyServer");

// Zigbee, ESPHome and friends expose "make this device announce itself" as a
// button on the same HA device, either flagged device_class: identify or just
// named for it (#447).
const IDENTIFY_BUTTON_SUFFIXES = ["_identify", "_locate", "_find_me"];

export class IdentifyServer extends Base {
  override identify(request: Identify.IdentifyRequest) {
    if (request.identifyTime > 0) {
      this.identifyInHomeAssistant("identify");
    }
    // The base owns the countdown and the attribute.
    return super.identify(request);
  }

  override triggerEffect(effect: Identify.TriggerEffectRequest) {
    // Stop and Finish end an effect, pressing a one-shot button there would
    // start a new one.
    if (
      effect.effectIdentifier !== Identify.EffectIdentifier.StopEffect &&
      effect.effectIdentifier !== Identify.EffectIdentifier.FinishEffect
    ) {
      this.identifyInHomeAssistant("triggerEffect");
    }
    return super.triggerEffect(effect);
  }

  protected identifyInHomeAssistant(source: string) {
    // Plugin devices compose this without any entity behind it (#445).
    if (!this.agent.has(HomeAssistantEntityBehavior)) return;
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const target = this.findIdentifyEntity(homeAssistant);
    if (!target) {
      logger.debug(
        `${source} for ${homeAssistant.entityId}, no identify entity on this device`,
      );
      return;
    }
    logger.info(
      `${source} → button.press ${target} for ${homeAssistant.entityId}`,
    );
    homeAssistant.callAction({ action: "button.press", target });
  }

  // Searches the FULL registry: an identify button rarely matches the bridge
  // filter, same reason the battery and problem lookups do it.
  protected findIdentifyEntity(
    homeAssistant: HomeAssistantEntityBehavior,
  ): string | undefined {
    const deviceId = homeAssistant.entity.registry?.device_id;
    if (!deviceId) return undefined;
    const registry = this.env.maybeGet(HomeAssistantRegistry);
    if (!registry) return undefined;
    let byName: string | undefined;
    for (const entity of Object.values(registry.entities)) {
      if (entity.device_id !== deviceId) continue;
      if (entity.disabled_by != null) continue;
      if (!entity.entity_id.startsWith("button.")) continue;
      const deviceClass =
        registry.states[entity.entity_id]?.attributes?.device_class;
      if (deviceClass === "identify") return entity.entity_id;
      const uniqueId = entity.unique_id ?? "";
      if (
        byName == null &&
        IDENTIFY_BUTTON_SUFFIXES.some(
          (s) => entity.entity_id.endsWith(s) || uniqueId.endsWith(s),
        )
      ) {
        byName = entity.entity_id;
      }
    }
    return byName;
  }
}
