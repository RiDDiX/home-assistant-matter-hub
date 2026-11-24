import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { resolveCleaningModeOptions } from "../../create-legacy-endpoint-type.js";
import {
  buildSupportedModes,
  createCleanModeConfig,
} from "./vacuum-rvc-clean-mode-server.js";

const fan = ["quiet", "standard", "strong", "turbo"];
const water = ["low", "medium", "high"];
const SENTINEL = {
  state: "unavailable",
  attributes: { options: ["unavailable"] },
};
const DREAME = [
  "sweeping",
  "mopping",
  "sweeping_and_mopping",
  "mopping_after_sweeping",
];

type States = Record<string, { state: string; attributes: object }>;

function agentFor(states: States, mapping: object) {
  const actions: HomeAssistantAction[] = [];
  const agent = {
    get: () => ({
      entityId: "vacuum.l10s_pro_gen3",
      state: { mapping },
      callAction: (a: HomeAssistantAction) => actions.push(a),
    }),
    env: { get: () => ({ getState: (id: string) => states[id] }) },
  } as unknown as Agent;
  return { agent, actions };
}

const modes = (options: string[]) =>
  buildSupportedModes(fan, water, options).map((m) => m.mode);

function registeredOptions(options: string[] | undefined) {
  const registry = {
    initialStateIncludingUnfiltered: () =>
      options ? { attributes: { options } } : undefined,
  };
  return resolveCleaningModeOptions(
    registry as never,
    { entity_id: "vacuum.l10s_pro_gen3", state: { attributes: {} } } as never,
    { entityId: "vacuum.l10s_pro_gen3", cleaningModeEntity: "select.cm" },
  );
}

const mapping = {
  cleaningModeEntity: "select.cleaning_mode",
  suctionLevelEntity: "select.suction_level",
  mopIntensityEntity: "select.water_volume",
};

describe("Dreame with all auxiliary selects unavailable", () => {
  const states = {
    "select.cleaning_mode": SENTINEL,
    "select.suction_level": SENTINEL,
    "select.water_volume": SENTINEL,
  };

  it("does not invent a fan speed from an unavailable suction select", () => {
    const options = ["vacuum", "mop"];
    const current = createCleanModeConfig(fan, water, options).getCurrentMode(
      { attributes: { cleaning_mode: "vacuum" } },
      agentFor(states, mapping).agent,
    );
    expect(modes(options)).toContain(current);
    expect(current).toBe(0);
  });

  it("does not invent a mop intensity from an unavailable water select", () => {
    const options = ["vacuum", "mop"];
    const current = createCleanModeConfig(fan, water, options).getCurrentMode(
      { attributes: { cleaning_mode: "mop" } },
      agentFor(states, mapping).agent,
    );
    expect(current).toBe(2);
  });

  it("sends no unavailable option for a fan speed or mop intensity", () => {
    const options = registeredOptions(["unavailable"]);
    const { agent, actions } = agentFor(states, mapping);
    const config = createCleanModeConfig(fan, water, options);
    const sent = [10, 11, 50, 51, 2].map((m) => config.setCleanMode(m, agent));
    for (const a of [...sent, ...actions]) {
      expect(JSON.stringify(a ?? {})).not.toContain("unavailable");
    }
    expect(sent).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(actions).toEqual([]);
  });

  it("follows the real options once the cleaning mode select comes back", () => {
    const options = registeredOptions(["unavailable"]);
    const live: States = {
      "select.cleaning_mode": {
        state: "mopping",
        attributes: { options: DREAME },
      },
    };
    const { agent, actions } = agentFor(live, {
      cleaningModeEntity: "select.cleaning_mode",
      mopIntensityEntity: "select.water_volume",
    });
    const config = createCleanModeConfig(fan, water, options);
    expect(config.getCurrentMode({ attributes: {} }, agent)).toBe(2);
    live["select.cleaning_mode"].state = "sweeping_and_mopping";
    expect(config.getCurrentMode({ attributes: {} }, agent)).toBe(1);

    expect(config.setCleanMode(2, agent)).toMatchObject({
      data: { option: "mopping" },
    });
    live["select.water_volume"] = {
      state: "low",
      attributes: { options: water },
    };
    expect(config.setCleanMode(51, agent)).toEqual({
      action: "select.select_option",
      data: { option: "medium" },
      target: "select.water_volume",
    });
    expect(actions).toEqual([
      {
        action: "select.select_option",
        data: { option: "mopping" },
        target: "select.cleaning_mode",
      },
    ]);
  });
});

describe("vacuum attribute cleaning_mode unknown", () => {
  const current = (state: { state: string; attributes: object }) =>
    createCleanModeConfig(fan, water, DREAME).getCurrentMode(
      { attributes: { cleaning_mode: "unknown" } },
      agentFor(
        { "select.cleaning_mode": state },
        { cleaningModeEntity: "select.cleaning_mode" },
      ).agent,
    );

  it("takes the clean type from the cleaning mode select", () => {
    expect(current({ state: "mopping", attributes: { options: DREAME } })).toBe(
      2,
    );
  });

  it("keeps the current mode while the select is unavailable too", () => {
    expect(current(SENTINEL)).toBeUndefined();
  });
});

describe("resolveCleaningModeOptions with unavailable options", () => {
  it("falls back to the defaults for an unavailable list", () => {
    expect(registeredOptions(["unavailable"])).toEqual([
      "vacuum",
      "mop",
      "vacuum_and_mop",
      "vacuum_then_mop",
    ]);
  });

  it("keeps the real options next to unavailable", () => {
    expect(registeredOptions(["unavailable", "sweeping", "mopping"])).toEqual([
      "sweeping",
      "mopping",
    ]);
    expect(registeredOptions(["Unknown", "mopping"])).toEqual(["mopping"]);
  });

  it("keeps an empty list as it is", () => {
    expect(registeredOptions([])).toEqual([]);
  });
});
