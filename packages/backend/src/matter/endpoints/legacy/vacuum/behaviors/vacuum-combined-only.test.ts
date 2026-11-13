import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { RvcCleanMode } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import {
  buildSupportedModes,
  CleanType,
  createCleanModeConfig,
  parseCleanType,
} from "./vacuum-rvc-clean-mode-server.js";

const fan = ["quiet", "balanced", "turbo", "max", "gentle"];
const water = ["low", "medium", "high"];
const combined = ["vacuum", "vac_and_mop"];

function fixture(
  options = combined,
  cleanState = options.includes("mop") ? "mop" : "vac_and_mop",
) {
  const actions: (HomeAssistantAction | undefined)[] = [];
  const entity: HomeAssistantEntityState<{ fan_speed: string }> = {
    entity_id: "vacuum.robot",
    state: "cleaning",
    attributes: { fan_speed: "max" },
    context: { id: "test" },
    last_changed: "2026-01-01T00:00:00Z",
    last_updated: "2026-01-01T00:00:00Z",
  };
  const states = {
    "select.clean_mode": {
      state: cleanState,
      attributes: { options },
    },
    "select.water": {
      state: "high",
      attributes: { options: ["off", ...water] },
    },
  };
  const agent = {
    get: () => ({
      entityId: "vacuum.robot",
      state: {
        mapping: {
          cleaningModeEntity: "select.clean_mode",
          mopIntensityEntity: "select.water",
        },
      },
      callAction: (action: HomeAssistantAction | undefined) =>
        actions.push(action),
    }),
    env: {
      get: () => ({
        getState: (id: keyof typeof states) => states[id],
      }),
    },
  } as unknown as Agent;
  return { agent, entity, actions };
}

describe("combined-only cleaning modes", () => {
  it.each([
    "vac_and_mop",
    "vac+mop",
    "Vac & Mop",
  ])("recognizes %s as vacuum and mop", (option) =>
    expect(parseCleanType(option)).toBe(CleanType.SweepingAndMopping));

  it("does not advertise a mop-only cleaning type or water mode", () => {
    const modes = buildSupportedModes(fan, water, combined);
    expect(modes.some((mode) => mode.mode === 2)).toBe(false);
    const waterModes = modes.filter((mode) => mode.mode >= 50);
    expect(waterModes.map((mode) => mode.mode)).toEqual([50, 51, 52]);
    for (const mode of waterModes) {
      expect(mode.label).toMatch(/^Vacuum & Mop /);
      expect(mode.modeTags).toContainEqual({
        value: RvcCleanMode.ModeTag.Vacuum,
      });
      expect(mode.modeTags).toContainEqual({ value: RvcCleanMode.ModeTag.Mop });
    }
  });

  it("uses the supported combined option before setting water intensity", () => {
    const { agent, actions } = fixture();
    const config = createCleanModeConfig(fan, water, combined);
    expect(config.setCleanMode(51, agent)).toEqual({
      action: "select.select_option",
      target: "select.water",
      data: { option: "medium" },
    });
    expect(actions).toEqual([
      {
        action: "select.select_option",
        target: "select.clean_mode",
        data: { option: "vac_and_mop" },
      },
    ]);
  });

  it.each([
    2, 50, 51, 52,
  ])("routes fallback-registered mode %s using the actual live combined option", (mode) => {
    const { agent, actions } = fixture();
    const config = createCleanModeConfig(fan, water, [
      "vacuum",
      "mop",
      "vacuum_and_mop",
      "vacuum_then_mop",
    ]);
    const action = config.setCleanMode(mode, agent);
    const cleanAction = [...actions, action].find(
      (item) => item?.target === "select.clean_mode",
    );
    expect(cleanAction?.data).toEqual({ option: "vac_and_mop" });
  });

  it("reports the combined intensity using the advertised mode ID", () => {
    const { agent, entity } = fixture();
    expect(
      createCleanModeConfig(fan, water, combined).getCurrentMode(entity, agent),
    ).toBe(52);
  });

  it("keeps mop-only intensity behavior for devices supporting mop-only", () => {
    const options = ["vacuum", "mop", "vacuum_and_mop"];
    const modes = buildSupportedModes(fan, water, options);
    expect(
      modes
        .filter((mode) => mode.mode >= 50)
        .every(
          (mode) =>
            !mode.modeTags.some(
              (tag) => tag.value === RvcCleanMode.ModeTag.Vacuum,
            ),
        ),
    ).toBe(true);
    const { agent, actions } = fixture(options);
    createCleanModeConfig(fan, water, options).setCleanMode(50, agent);
    expect(actions[0]?.data).toEqual({ option: "mop" });
  });

  it("splits Roborock vac_and_mop from mop on the HA cleaning mode select", () => {
    const options = ["vacuum", "vac_and_mop", "mop", "custom", "smart_mode"];
    const modes = buildSupportedModes(fan, water, options);
    expect(modes.find((mode) => mode.mode === 1)?.label).toBe("Vacuum & Mop");
    for (const mode of [2, 50]) {
      const { agent, actions } = fixture(options);
      const action = createCleanModeConfig(fan, water, options).setCleanMode(
        mode,
        agent,
      );
      const cleanAction = [...actions, action].find(
        (item) => item?.target === "select.clean_mode",
      );
      expect(cleanAction?.data).toEqual({ option: "mop" });
    }
    const { agent, entity } = fixture(options, "vac_and_mop");
    expect(
      createCleanModeConfig(fan, water, options).getCurrentMode(entity, agent),
    ).toBe(1);
  });
});
