import {
  ClusterId,
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Behavior, EventEmitter } from "@matter/main";
import { StatusCode, StatusResponseError } from "@matter/main/types";

import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AsyncObservable } from "../../utils/async-observable.js";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";

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

  // #446: fail the command instead of telling the controller it worked while
  // the call never reaches HA. `=== false` on purpose: test stubs do not
  // define `available`, and undefined must read as "no opinion".
  // ponytail: commands only. Attribute writes that fan and thermostat handle
  // in reactors run as a local actor, so they still go through and rely on HA
  // state to correct them. Plumb it there too if that shows up in reports.
  assertAvailable() {
    const actions = this.env.get(HomeAssistantActions);
    // Optional call: test stubs define neither member.
    const blocked =
      actions.available === false ||
      actions.isTargetBlocked?.(this.entityId) === true;
    if (blocked && !transactionIsOffline(this.context)) {
      throw new StatusResponseError(
        "Home Assistant is not reachable",
        StatusCode.Failure,
      );
    }
  }

  callAction(action: HomeAssistantAction) {
    this.assertAvailable();
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
