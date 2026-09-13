import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Endpoint } from "@matter/main";
import { describe, expect, it } from "vitest";
import { updateEntityState } from "./update-entity-state.js";

// #464: two covers moved in the same millisecond, the second setStateOf could
// not take the endpoint lock synchronously and matter.js dropped the position
// attributes with a warning. Writes are serialized per endpoint now.

function state(value: string): HomeAssistantEntityState {
  return {
    entity_id: "cover.test",
    state: value,
    attributes: {},
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function fakeEndpoint(
  setState: (state: HomeAssistantEntityState) => Promise<void>,
): Endpoint {
  return {
    construction: { ready: Promise.resolve() },
    stateOf: () => ({ entity: { entity_id: "cover.test" } }),
    setStateOf: (_behavior: unknown, patch: { entity: { state: unknown } }) =>
      setState(patch.entity.state as HomeAssistantEntityState),
    // biome-ignore lint/suspicious/noExplicitAny: endpoint stub
  } as any;
}

describe("#464 serialized endpoint state writes", () => {
  it("never runs two writes on one endpoint at the same time", async () => {
    let running = 0;
    let overlapped = false;
    const seen: string[] = [];
    const endpoint = fakeEndpoint(async (s) => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push(s.state);
      running--;
    });

    const first = updateEntityState(endpoint, state("opening"));
    const second = updateEntityState(endpoint, state("open"));
    await Promise.all([first, second]);

    expect(overlapped).toBe(false);
    expect(seen).toEqual(["opening", "open"]);
  });

  it("keeps the order after a failed write", async () => {
    const seen: string[] = [];
    const endpoint = fakeEndpoint(async (s) => {
      if (s.state === "boom") throw new Error("write failed");
      seen.push(s.state);
    });

    const failing = updateEntityState(endpoint, state("boom"));
    const next = updateEntityState(endpoint, state("open"));
    await expect(failing).rejects.toThrow("write failed");
    await next;

    expect(seen).toEqual(["open"]);
  });

  it("drops a write against a detached endpoint", async () => {
    const endpoint = fakeEndpoint(async () => {
      throw new Error(
        'Behavior "homeAssistantEntity" is not present on this endpoint',
      );
    });

    await expect(
      updateEntityState(endpoint, state("open")),
    ).resolves.toBeUndefined();
  });
});
