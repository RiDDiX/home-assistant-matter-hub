import type {
  HomeAssistantEntityInformation,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { OccupancySensingServer as Base } from "@matter/main/behaviors";
import { OccupancySensing } from "@matter/main/clusters";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const OccupancySensingServerBase = Base.with(
  OccupancySensing.Feature.PhysicalContact,
);

export class OccupancySensingServer extends OccupancySensingServerBase {
  override async initialize() {
    // Matter.js defaults: occupancy={}, occupancySensorTypeBitmap={}
    // These are valid per Matter spec - we set actual values in update()
    // No overrides needed here

    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const { state } = entity;
    applyPatchState(this.state, {
      occupancy: { occupied: this.isOccupied(state) },
      occupancySensorType: OccupancySensing.OccupancySensorType.PhysicalContact,
      occupancySensorTypeBitmap: {
        pir: false,
        physicalContact: true,
        ultrasonic: false,
      },
    });
  }

  private isOccupied(state: HomeAssistantEntityState): boolean {
    return (
      this.agent.get(HomeAssistantEntityBehavior).isAvailable &&
      state.state !== "off"
    );
  }
}
