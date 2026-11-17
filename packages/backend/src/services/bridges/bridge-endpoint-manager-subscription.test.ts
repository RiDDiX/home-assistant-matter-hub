import { describe, expect, it, vi } from "vitest";
import { subscribeEntities } from "../home-assistant/api/subscribe-entities.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";

// Every refresh ends in startObserving. It used to drop and redo the HA
// subscription each time, so HA resent the full state map on every refresh
// and every start gate retry.

vi.mock("../home-assistant/api/subscribe-entities.js", () => ({
  subscribeEntities: vi.fn(() => vi.fn()),
}));

function manager(entityIds: string[]) {
  const m = Object.create(BridgeEndpointManager.prototype);
  Object.assign(m, {
    entityIds,
    root: { parts: [] },
    mappingSync: { candidateSensorIds: () => [] },
    client: { connection: {} },
    log: { warn: vi.fn() },
    updateStates: vi.fn(async () => {}),
  });
  return m as {
    startObserving: BridgeEndpointManager["startObserving"];
    entityIds: string[];
    updateStates: ReturnType<typeof vi.fn>;
  };
}

describe("startObserving keeps an unchanged subscription", () => {
  it("subscribes again only when the entity id set changes", async () => {
    const subscribe = vi.mocked(subscribeEntities);
    subscribe.mockClear();
    const m = manager(["light.a", "switch.b"]);

    await m.startObserving();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const states = { "light.a": {} } as never;
    subscribe.mock.calls[0][1](states, null);
    const firstUnsubscribe = subscribe.mock.results[0].value;

    // same set in another order: kept, rebuilt endpoints get the last map
    m.entityIds = ["switch.b", "light.a"];
    m.updateStates.mockClear();
    await m.startObserving();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(firstUnsubscribe).not.toHaveBeenCalled();
    expect(m.updateStates).toHaveBeenCalledWith(states);

    m.entityIds = ["light.a", "switch.b", "fan.c"];
    await m.startObserving();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
