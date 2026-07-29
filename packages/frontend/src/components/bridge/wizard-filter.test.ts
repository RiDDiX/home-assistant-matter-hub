import { HomeAssistantMatcherType } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { buildIncludeMatchers } from "./wizard-filter.ts";

describe("buildIncludeMatchers", () => {
  it("wraps the wildcard as a single pattern matcher", () => {
    expect(
      buildIncludeMatchers({
        filterType: "pattern",
        useWildcard: true,
        entityPattern: "",
        labelValues: [],
      }),
    ).toEqual([{ type: HomeAssistantMatcherType.Pattern, value: "*" }]);
  });

  it("splits comma separated domains", () => {
    expect(
      buildIncludeMatchers({
        filterType: "domain",
        useWildcard: false,
        entityPattern: "light, switch",
        labelValues: [],
      }),
    ).toEqual([
      { type: HomeAssistantMatcherType.Domain, value: "light" },
      { type: HomeAssistantMatcherType.Domain, value: "switch" },
    ]);
  });

  it("maps areas to area matchers", () => {
    expect(
      buildIncludeMatchers({
        filterType: "area",
        useWildcard: false,
        entityPattern: "living_room",
        labelValues: [],
      }),
    ).toEqual([{ type: HomeAssistantMatcherType.Area, value: "living_room" }]);
  });

  it("maps selected labels to entity label matchers", () => {
    expect(
      buildIncludeMatchers({
        filterType: "label",
        useWildcard: false,
        entityPattern: "",
        labelValues: ["matter", "kitchen"],
      }),
    ).toEqual([
      { type: HomeAssistantMatcherType.EntityLabel, value: "matter" },
      { type: HomeAssistantMatcherType.EntityLabel, value: "kitchen" },
    ]);
  });
});
