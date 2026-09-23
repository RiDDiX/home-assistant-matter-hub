import { describe, expect, it } from "vitest";
import { pairingIndex, trailingIndex } from "./trailing-index.js";

describe("trailingIndex", () => {
  it("returns the trailing integer", () => {
    expect(trailingIndex("switch.strip_switch_2")).toBe(2);
    expect(trailingIndex("sensor.strip_power_2")).toBe(2);
  });

  it("takes the last number when several are present", () => {
    expect(trailingIndex("sensor.power_strip_4_power_3")).toBe(3);
  });

  it("returns undefined without a trailing number", () => {
    expect(trailingIndex("sensor.strip_power")).toBeUndefined();
    expect(trailingIndex("switch.kitchen_top")).toBeUndefined();
  });
});

describe("pairingIndex", () => {
  it("reads the index from where the two ids differ", () => {
    expect(pairingIndex("switch.strip_switch_2", "sensor.strip_power_2")).toBe(
      2,
    );
    expect(pairingIndex("sensor.strip_power_2", "switch.strip_switch_2")).toBe(
      2,
    );
  });

  // the #488 device is a "Shelly Power Strip 4"
  it("ignores a number that belongs to the shared device name", () => {
    expect(
      pairingIndex(
        "switch.kitchen_shelly_power_strip_4",
        "sensor.kitchen_shelly_power_strip_4_power_1",
      ),
    ).toBeUndefined();
    expect(trailingIndex("switch.kitchen_shelly_power_strip_4")).toBe(4);
  });

  it("pairs the ids Home Assistant generates for a multi-outlet Matter device", () => {
    for (const i of [1, 2, 3, 4]) {
      expect(
        pairingIndex(
          `switch.kitchen_shelly_power_strip_4_switch_${i}`,
          `sensor.kitchen_shelly_power_strip_4_power_${i}`,
        ),
      ).toBe(i);
    }
  });

  it("has no index when the ids differ only by a word", () => {
    expect(pairingIndex("switch.strip", "sensor.strip_power")).toBeUndefined();
  });
});

describe("pairingIndex numeric tokens", () => {
  it("compares whole numbers, not the digits left after the shared prefix", () => {
    expect(
      pairingIndex("sensor.strip_power_101", "sensor.strip_power_11"),
    ).toBe(101);
    expect(
      pairingIndex("sensor.strip_power_11", "sensor.strip_power_101"),
    ).toBe(11);
  });

  it("keeps neighbouring outlets apart", () => {
    expect(pairingIndex("switch.strip_10", "switch.strip_11")).toBe(10);
  });

  it("has no index when one id is the start of the other", () => {
    expect(
      pairingIndex("sensor.strip_power_1", "sensor.strip_power_12"),
    ).toBeUndefined();
  });
});
