import type {
  EventDeviceAttributes,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { ActionContext, Endpoint } from "@matter/main";
import { SwitchServer as Base } from "@matter/main/behaviors";
import type { Switch } from "@matter/main/clusters";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("GenericSwitchServer");

/**
 * Variant without the MomentarySwitchMultiPress feature. Used for event
 * entities that only expose single/long press. multiPressMax has a min: 2
 * constraint in the Matter Switch cluster, so devices without multi-press
 * must drop the feature instead of setting max=1 (which fails validation
 * with "Behaviors have errors").
 */
const SimpleBase = Base.with(
  "MomentarySwitch",
  "MomentarySwitchRelease",
  "MomentarySwitchLongPress",
);

// An entity$Changed only used to mean "the Home Assistant state moved", so
// firing a press on every one of them was enough. It also fires now when only
// the registry snapshot behind an endpoint is refreshed (#467), and a device
// rename must not look like a button press to the controller. HA event entities
// carry the event timestamp in `state`, so that plus the event type identifies
// one press.
//
// Keyed on the endpoint, not the entity id: a behavior instance field is reset
// on every transaction, while an entity-keyed module map would be shared by two
// bridges exposing the same entity and would swallow the second one's press. A
// rebuilt endpoint is a new key, so its first press always gets through.
const lastFiredEvents = new WeakMap<Endpoint, string>();

function eventKey(entity: HomeAssistantEntityInformation): string | undefined {
  const eventType = (
    entity?.state?.attributes as EventDeviceAttributes | undefined
  )?.event_type;
  if (!eventType) return undefined;
  return `${entity.state.state} ${eventType}`;
}

function seedLastEvent(
  endpoint: Endpoint,
  entity: HomeAssistantEntityInformation,
) {
  const key = eventKey(entity);
  if (key) {
    lastFiredEvents.set(endpoint, key);
  }
}

function isRepeatedEvent(endpoint: Endpoint, key: string): boolean {
  if (lastFiredEvents.get(endpoint) === key) {
    return true;
  }
  lastFiredEvents.set(endpoint, key);
  return false;
}

// HA reports a long press after the fact and often without a release, so the
// whole sequence goes out at once and the switch ends at position 0. Endpoints
// listed here already sent the release for their next long_release.
const releasedLongPress = new WeakSet<Endpoint>();

function isLongPress(lower: string): boolean {
  return (
    (lower.includes("long") && !lower.includes("release")) || lower === "hold"
  );
}

function isLongRelease(lower: string): boolean {
  return lower.includes("long") && lower.includes("release");
}

// One rule for the press count a single event type stands for, shared with
// the endpoint's multiPressMax so the two cannot drift.
export function pressCountOf(eventType: string): number {
  const lower = eventType.toLowerCase();
  if (/triple|3_press|three/.test(lower)) return 3;
  if (/double|2_press|two|multi/.test(lower)) return 2;
  return 1;
}

// Hue sends initial_press ahead of every short_release and long_press, and
// repeat while a button is held, so firing on them doubles every press. The
// Hue Tap switch only lists initial_press, there it is the press itself.
function isHuePressPhase(lower: string, eventTypes: string[] | undefined) {
  return (
    lower === "repeat" ||
    (lower === "initial_press" && !!eventTypes?.includes("short_release"))
  );
}

function fireBridgeEvent(
  agent: {
    get(b: typeof HomeAssistantEntityBehavior): HomeAssistantEntityBehavior;
  },
  eventType: string,
  pressCount: number,
) {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  homeAssistant.fireEvent("hamh_action", {
    action: "press",
    event_type: eventType,
    press_count: pressCount,
    source: "matter_bridge",
  });
}

// The class is typed as the simple variant, only the multi-press one built
// from it with .with() carries this event.
interface MultiPressEvents {
  multiPressComplete: {
    emit(event: Switch.MultiPressCompleteEvent, context: ActionContext): void;
  };
}

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace below
class HaGenericSwitchServerBase extends SimpleBase {
  declare state: HaGenericSwitchServerBase.State;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;

    logger.debug(`[${entityId}] GenericSwitch initialized`);

    // The entity usually already carries the last event it saw. Claim it now,
    // or the first entity change after mount replays it as a fresh press.
    seedLastEvent(this.endpoint, homeAssistant.entity);

    this.reactTo(homeAssistant.onChange, this.handleEventChange, {
      lock: true,
    });
  }

  private handleEventChange() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity;
    if (!entity?.state || !entity.state.attributes) return;

    const attrs = entity.state.attributes as EventDeviceAttributes;
    const eventType = attrs.event_type;

    if (!eventType) return;

    const entityId = homeAssistant.entityId;
    const key = `${entity.state.state} ${eventType}`;
    if (isRepeatedEvent(this.endpoint, key)) {
      return;
    }
    logger.debug(`[${entityId}] Event fired: ${eventType}`);

    this.triggerPress(eventType, attrs.event_types);
  }

  private triggerPress(eventType: string, eventTypes: string[] | undefined) {
    const lower = eventType.toLowerCase();

    if (isLongPress(lower)) {
      releasedLongPress.add(this.endpoint);
      this.emitLongPress();
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    if (isLongRelease(lower)) {
      // The long press already sent its release. Only send the sequence when
      // the press itself was lost (e.g. coalesced by debounce).
      if (!releasedLongPress.delete(this.endpoint)) {
        this.emitLongPress();
      }
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    // Continuous hold (e.g. press_cont), ignore, longPress already sent
    if (lower.includes("cont") && lower.includes("press")) {
      return;
    }

    if (isHuePressPhase(lower, eventTypes)) {
      return;
    }

    // Only the multi-press variant counts, the simple one reports single
    // presses.
    const multi = this.features.momentarySwitchMultiPress;
    const pressCount = multi ? pressCountOf(eventType) : 1;
    this.state.currentPosition = 1;
    this.events.initialPress.emit({ newPosition: 1 }, this.context);
    this.state.currentPosition = 0;
    this.events.shortRelease.emit({ previousPosition: 1 }, this.context);
    if (multi) {
      (this.events as unknown as MultiPressEvents).multiPressComplete.emit(
        { previousPosition: 0, totalNumberOfPressesCounted: pressCount },
        this.context,
      );
    }

    fireBridgeEvent(this.agent, eventType, pressCount);
  }

  private emitLongPress() {
    this.state.currentPosition = 1;
    this.events.initialPress.emit({ newPosition: 1 }, this.context);
    this.events.longPress.emit({ newPosition: 1 }, this.context);
    this.state.currentPosition = 0;
    this.events.longRelease.emit({ previousPosition: 1 }, this.context);
  }
}

namespace HaGenericSwitchServerBase {
  export class State extends SimpleBase.State {}
}

/**
 * Full variant with MomentarySwitchMultiPress for devices whose event_types
 * include double/triple press. .with() replaces the feature set, so the base
 * features are listed again.
 */
const HaGenericSwitchServerMultiBase = HaGenericSwitchServerBase.with(
  "MomentarySwitch",
  "MomentarySwitchRelease",
  "MomentarySwitchLongPress",
  "MomentarySwitchMultiPress",
);

/**
 * Simple variant: single/long press only. Used when an event entity has no
 * double/triple press event types. The MomentarySwitchMultiPress feature is
 * omitted so Apple Home hides the "Double Press" action.
 */
export const HaGenericSwitchServerSimple = HaGenericSwitchServerBase.set({
  numberOfPositions: 2,
  currentPosition: 0,
});

/**
 * Full variant with multi-press support. multiPressMax is overridden per
 * endpoint in EventDevice based on the entity's event_types.
 */
export const HaGenericSwitchServer = HaGenericSwitchServerMultiBase.set({
  numberOfPositions: 2,
  currentPosition: 0,
  multiPressMax: 3,
});
