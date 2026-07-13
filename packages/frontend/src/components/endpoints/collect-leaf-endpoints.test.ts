import type { EndpointData } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { collectLeafEndpoints } from "./collect-leaf-endpoints.ts";

function leaf(local: string, state: object = {}): EndpointData {
  return {
    id: { global: local, local },
    type: { name: "Light", id: "0x0100" },
    endpoint: 1,
    state,
    parts: [],
  };
}

function parent(state: object, parts: EndpointData[]): EndpointData {
  return {
    id: { global: "parent", local: "parent" },
    type: { name: "BridgedNode", id: "0x0013" },
    endpoint: 2,
    state,
    parts,
  };
}

function batteryOf(ep: EndpointData): number | undefined {
  const state = ep.state as {
    powerSource?: { batPercentRemaining?: number };
  };
  return state.powerSource?.batPercentRemaining;
}

describe("collectLeafEndpoints", () => {
  it("hoists the parent battery onto the first leaf (#408)", () => {
    const a = leaf("a");
    const b = leaf("b");
    const composed = parent({ powerSource: { batPercentRemaining: 160 } }, [
      a,
      b,
    ]);

    const result = collectLeafEndpoints(composed);

    expect(result).toHaveLength(2);
    expect(batteryOf(result[0])).toBe(160);
    // second leaf and the original stay untouched
    expect(batteryOf(result[1])).toBeUndefined();
    expect(result[0]).not.toBe(a);
    expect(batteryOf(a)).toBeUndefined();
  });

  it("does not overwrite a leaf that already has its own battery", () => {
    const a = leaf("a", { powerSource: { batPercentRemaining: 40 } });
    const composed = parent({ powerSource: { batPercentRemaining: 160 } }, [a]);

    const result = collectLeafEndpoints(composed);

    expect(batteryOf(result[0])).toBe(40);
  });

  it("passes a standalone leaf through unchanged", () => {
    const a = leaf("a", { onOff: { onOff: true } });

    const result = collectLeafEndpoints(a);

    expect(result).toEqual([a]);
    expect(result[0]).toBe(a);
  });

  it("leaves children unchanged when the parent has no battery", () => {
    const a = leaf("a");
    const b = leaf("b");
    const composed = parent({}, [a, b]);

    const result = collectLeafEndpoints(composed);

    expect(result[0]).toBe(a);
    expect(result[1]).toBe(b);
  });
});
