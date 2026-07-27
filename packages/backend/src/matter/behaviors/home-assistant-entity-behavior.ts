import {
  ClusterId,
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Behavior, EventEmitter } from "@matter/main";

import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AsyncObservable } from "../../utils/async-observable.js";

export class HomeAssistantEntityBehavior extends Behavior {
  static override readonly id = ClusterId.homeAssistantEntity;
  declare state: HomeAssistantEntityBehavior.State;
  declare events: HomeAssistantEntityBehavior.Events;

  get entityId(): string {
    return this.entity.entity_id;
  }

  get entity(): HomeAssistantEntityInformation {
    return this.state.entity;
  }

  get onChange(): HomeAssistantEntityBehavior.Events["entity$Changed"] {
    return this.events.entity$Changed;
  }

  get isAvailable(): boolean {
    return (
      this.entity.state.state !== "unavailable" &&
      this.entity.state.state !== "unknown"
    );
  }

  callAction(action: HomeAssistantAction) {
    const actions = this.env.get(HomeAssistantActions);
    actions.call(action, this.entityId);
  }

  fireEvent(eventType: string, eventData?: Record<string, unknown>) {
    const actions = this.env.get(HomeAssistantActions);
    actions.fireEvent(eventType, {
      entity_id: this.entityId,
      ...eventData,
    });
  }
}

export namespace HomeAssistantEntityBehavior {
  export class State {
    entity!: HomeAssistantEntityInformation;
    customName?: string;
    /** Entity mapping configuration (optional, used for advanced features like filter life sensor) */
    mapping?: EntityMappingConfig;
    /**
     * Stable identity anchor for uniqueId/serialNumber. Set to the entity_id the
     * identity was first seeded under, so those stay frozen across HA renames.
     * Undefined falls back to the live entity_id (legacy behaviour).
     */
    identityAnchor?: string;
  }

  export class Events extends EventEmitter {
    entity$Changed = AsyncObservable<HomeAssistantEntityInformation>();
  }
}
