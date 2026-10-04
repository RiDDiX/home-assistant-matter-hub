import {
  ClusterId,
  type EntityMappingConfig,
  type HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Observable } from "@matter/general";
import { Behavior, EventEmitter } from "@matter/main";
import { StatusCode, StatusResponseError } from "@matter/main/types";

import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../services/home-assistant/home-assistant-actions.js";
import { AsyncObservable } from "../../utils/async-observable.js";
import { transactionIsOffline } from "../../utils/transaction-is-offline.js";
import { updateEntityState } from "../endpoints/update-entity-state.js";

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
    const onChange = this.events.entity$Changed;
    // matter.js hands out a proxy per behavior and the proxy does not carry the
    // async flag of the observable it wraps, so reactors reject an async update
    // and the state write has to take its lock synchronously. Restore the flag
    // the Events class declares, then a reactor can wait for the lock (#464).
    onChange.isAsync = true;
    // Reactors on this must return nothing: matter.js stops the emission at the
    // first observer that resolves to a value, so a returning update() would
    // cut every behavior registered after it out of the fan-out.
    return onChange;
  }

  get isAvailable(): boolean {
    return (
      this.entity.state.state !== "unavailable" &&
      this.entity.state.state !== "unknown"
    );
  }

  override initialize() {
    // Optional: test stubs neither register the service nor define `failed`.
    const failed = this.env.maybeGet(HomeAssistantActions)?.failed;
    if (failed) {
      this.reactTo(failed, this.rollback);
    }
  }

  // #446: the command already returned success, only assertAvailable can
  // still fail it. Drop the optimistic holds and re-apply the HA state so the
  // subscription shows the truth.
  private rollback(entityId: string) {
    if (entityId !== this.entityId) return;
    this.events.actionFailed.emit();
    updateEntityState(this.endpoint).catch(() => {});
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
    // an HA call this entity issued failed, see rollback()
    actionFailed = Observable<[]>();
  }
}
