import { describe, expect, it } from "vitest";
import { linkedEntities } from "./EndpointState";

describe("linkedEntities", () => {
  it("lists linked entities by mapping field and skips empty ones", () => {
    expect(
      linkedEntities({
        batteryEntity: "sensor.battery",
        powerEntity: "",
        matterDeviceType: "on_off_light",
        roomEntities: ["button.kitchen", "button.hall"],
      }),
    ).toEqual([
      { field: "batteryEntity", entity: "sensor.battery" },
      { field: "roomEntities", entity: "button.kitchen, button.hall" },
    ]);
  });

  it("returns nothing without a mapping", () => {
    expect(linkedEntities(undefined)).toEqual([]);
  });
});
