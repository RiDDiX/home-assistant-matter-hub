import type { EventDeviceAttributes } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { SwitchServer as Base } from "@matter/main/behaviors";
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

/**
 * Full variant with MomentarySwitchMultiPress for devices whose event_types
 * include double/triple press.
 */
const FullBase = Base.with(
  "MomentarySwitch",
  "MomentarySwitchRelease",
  "MomentarySwitchLongPress",
  "MomentarySwitchMultiPress",
);

function isLongPress(lower: string): boolean {
  return (
    (lower.includes("long") && !lower.includes("release")) || lower === "hold"
  );
}

function isLongRelease(lower: string): boolean {
  return lower.includes("long") && lower.includes("release");
}

function getPressCount(lower: string): number {
  if (
    lower.includes("triple") ||
    lower.includes("3_press") ||
    lower.includes("three")
  ) {
    return 3;
  }
  if (
    lower.includes("double") ||
    lower.includes("2_press") ||
    lower.includes("two") ||
    lower.includes("multi")
  ) {
    return 2;
  }
  return 1;
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

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace below
class HaGenericSwitchServerBase extends SimpleBase {
  declare state: HaGenericSwitchServerBase.State;
  private inLongPress = false;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;

    logger.debug(`[${entityId}] GenericSwitch initialized (simple)`);

    this.reactTo(homeAssistant.onChange, this.handleEventChange);
  }

  private handleEventChange() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity;
    if (!entity?.state || !entity.state.attributes) return;

    const attrs = entity.state.attributes as EventDeviceAttributes;
    const eventType = attrs.event_type;

    if (!eventType) return;

    const entityId = homeAssistant.entityId;
    logger.debug(`[${entityId}] Event fired: ${eventType}`);

    this.triggerPress(eventType);
  }

  private triggerPress(eventType: string) {
    const lower = eventType.toLowerCase();

    if (isLongPress(lower)) {
      this.inLongPress = true;
      this.state.currentPosition = 1;
      this.events.initialPress.emit({ newPosition: 1 }, this.context);
      this.events.longPress.emit({ newPosition: 1 }, this.context);
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    if (isLongRelease(lower)) {
      if (!this.inLongPress) {
        // Synthesize the missing InitialPress + LongPress when the preceding
        // press_long was lost (e.g. coalesced by debounce).
        this.state.currentPosition = 1;
        this.events.initialPress.emit({ newPosition: 1 }, this.context);
        this.events.longPress.emit({ newPosition: 1 }, this.context);
      }
      this.inLongPress = false;
      this.state.currentPosition = 0;
      this.events.longRelease.emit({ previousPosition: 1 }, this.context);
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    // Continuous hold (e.g. press_cont), ignore, longPress already sent
    if (lower.includes("cont") && lower.includes("press")) {
      return;
    }

    // Standard momentary press (single press only on this variant)
    this.state.currentPosition = 1;
    this.events.initialPress.emit({ newPosition: 1 }, this.context);
    this.state.currentPosition = 0;
    this.events.shortRelease.emit({ previousPosition: 1 }, this.context);

    fireBridgeEvent(this.agent, eventType, 1);
  }
}

namespace HaGenericSwitchServerBase {
  export class State extends SimpleBase.State {}
}

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace below
class HaGenericSwitchServerMultiBase extends FullBase {
  declare state: HaGenericSwitchServerMultiBase.State;
  private inLongPress = false;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;

    logger.debug(`[${entityId}] GenericSwitch initialized (multi)`);

    this.reactTo(homeAssistant.onChange, this.handleEventChange);
  }

  private handleEventChange() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const entity = homeAssistant.entity;
    if (!entity?.state || !entity.state.attributes) return;

    const attrs = entity.state.attributes as EventDeviceAttributes;
    const eventType = attrs.event_type;

    if (!eventType) return;

    const entityId = homeAssistant.entityId;
    logger.debug(`[${entityId}] Event fired: ${eventType}`);

    this.triggerPress(eventType);
  }

  private triggerPress(eventType: string) {
    const lower = eventType.toLowerCase();

    if (isLongPress(lower)) {
      this.inLongPress = true;
      this.state.currentPosition = 1;
      this.events.initialPress.emit({ newPosition: 1 }, this.context);
      this.events.longPress.emit({ newPosition: 1 }, this.context);
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    if (isLongRelease(lower)) {
      if (!this.inLongPress) {
        this.state.currentPosition = 1;
        this.events.initialPress.emit({ newPosition: 1 }, this.context);
        this.events.longPress.emit({ newPosition: 1 }, this.context);
      }
      this.inLongPress = false;
      this.state.currentPosition = 0;
      this.events.longRelease.emit({ previousPosition: 1 }, this.context);
      fireBridgeEvent(this.agent, eventType, 1);
      return;
    }

    if (lower.includes("cont") && lower.includes("press")) {
      return;
    }

    const pressCount = getPressCount(lower);

    this.state.currentPosition = 1;
    this.events.initialPress.emit({ newPosition: 1 }, this.context);
    this.state.currentPosition = 0;
    this.events.shortRelease.emit({ previousPosition: 1 }, this.context);
    this.events.multiPressComplete.emit(
      {
        previousPosition: 0,
        totalNumberOfPressesCounted: pressCount,
      },
      this.context,
    );

    fireBridgeEvent(this.agent, eventType, pressCount);
  }
}

namespace HaGenericSwitchServerMultiBase {
  export class State extends FullBase.State {}
}

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
