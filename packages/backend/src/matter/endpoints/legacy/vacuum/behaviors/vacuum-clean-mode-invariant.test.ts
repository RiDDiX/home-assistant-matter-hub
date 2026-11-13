import type { Agent } from "@matter/main";
import { describe, expect, it } from "vitest";
import type { HomeAssistantAction } from "../../../../../services/home-assistant/home-assistant-actions.js";
import {
  buildSupportedModes,
  createCleanModeConfig,
  matchTaggedOption,
} from "./vacuum-rvc-clean-mode-server.js";

const fan = ["quiet", "standard", "strong", "turbo"];
const water = ["low", "medium", "high"];
const MOP = "select.mop";
const CLEAN = "select.clean";
const SUCTION = "select.suction";

type States = Record<string, { state: string; attributes: object }>;

function agentFor(states: States, mapping: Record<string, string>) {
  const actions: HomeAssistantAction[] = [];
  const agent = {
    get: () => ({
      entityId: "vacuum.murre",
      state: { mapping },
      callAction: (a: HomeAssistantAction) => actions.push(a),
    }),
    env: { get: () => ({ getState: (id: string) => states[id] }) },
  } as unknown as Agent;
  return { agent, actions };
}

const mopState = {
  [MOP]: { state: "low", attributes: { options: water } },
};

function modesOf(
  fanList: string[] | undefined,
  waterList: string[] | undefined,
  options: string[] | undefined,
) {
  return buildSupportedModes(fanList, waterList, options).map((m) => m.mode);
}

describe("clean mode report: unsupported mode 50", () => {
  it.each([
    ["mop", ["vacuum"]],
    ["vacuum_and_mop", ["vacuum"]],
    ["mop", ["standard", "deep", "deep_plus", "fast", "custom"]],
    ["vacuum_and_mop", ["standard", "deep", "deep_plus", "fast", "custom"]],
    ["mop", ["low", "medium", "high"]],
  ])("reports an advertised mode for live %s registered as %j", (live, options) => {
    const entity = { attributes: { cleaning_mode: live, fan_speed: "x" } };
    const supported = modesOf(fan, water, options);
    expect(supported).toEqual([0, 10, 11, 12, 13]);

    const withMop = agentFor(mopState, { mopIntensityEntity: MOP });
    expect(supported).toContain(
      createCleanModeConfig(fan, water, options).getCurrentMode(
        entity,
        withMop.agent,
      ),
    );

    const noMop = agentFor({}, {});
    expect(modesOf(fan, undefined, options)).toEqual(supported);
    expect(supported).toContain(
      createCleanModeConfig(fan, undefined, options).getCurrentMode(
        entity,
        noMop.agent,
      ),
    );
  });
});

describe("clean mode invariant", () => {
  const registeredLists: (string[] | undefined)[] = [
    undefined,
    [],
    ["vacuum"],
    ["mop"],
    ["vacuum", "mop"],
    ["vacuum", "vacuum_and_mop"],
    ["vacuum", "vacuum_then_mop"],
    ["mop", "vacuum_and_mop"],
    ["vacuum", "mop", "vacuum_and_mop", "vacuum_then_mop"],
    ["standard", "deep", "fast"],
  ];
  const attributeValues = [
    undefined,
    "vacuum",
    "mop",
    "vacuum_and_mop",
    "vacuum_then_mop",
    "custom",
  ];
  const selectStates = [
    undefined,
    "vacuum",
    "mop",
    "vac_and_mop",
    "vacuum_then_mop",
    "unavailable",
  ];

  it("reports only advertised modes, or unknown while the select is unavailable", () => {
    for (const options of registeredLists) {
      for (const live of attributeValues) {
        for (const select of selectStates) {
          for (const mopMapped of [true, false]) {
            const waterList = mopMapped ? water : undefined;
            const states: States = mopMapped ? { ...mopState } : {};
            if (select !== undefined) {
              states[CLEAN] = { state: select, attributes: { options: [] } };
            }
            const { agent } = agentFor(
              states,
              mopMapped
                ? { cleaningModeEntity: CLEAN, mopIntensityEntity: MOP }
                : { cleaningModeEntity: CLEAN },
            );
            const entity = {
              attributes: { cleaning_mode: live, fan_speed: "turbo" },
            };
            const current = createCleanModeConfig(
              fan,
              waterList,
              options,
            ).getCurrentMode(entity, agent);
            const unknown =
              !!options?.length && !live && select === "unavailable";
            const context = JSON.stringify({
              options,
              live,
              select,
              mopMapped,
            });
            if (unknown) {
              expect(current, context).toBeUndefined();
            } else {
              expect(modesOf(fan, waterList, options), context).toContain(
                current,
              );
            }
          }
        }
      }
    }
  });
});

describe("clean mode while an intensity select is unavailable", () => {
  const options = ["vacuum", "mop"];
  const report = (live: string, id: string, state: string, list: string[]) => {
    const { agent } = agentFor(
      { [id]: { state, attributes: { options: list } } },
      id === SUCTION ? { suctionLevelEntity: id } : { mopIntensityEntity: id },
    );
    return createCleanModeConfig(fan, water, options).getCurrentMode(
      { attributes: { cleaning_mode: live } },
      agent,
    );
  };
  const advertised = modesOf(fan, water, options);

  it.each([
    "unavailable",
    "unknown",
  ])("reports Vacuum on suction %s while sweeping", (s) => {
    expect(report("vacuum", SUCTION, "strong", fan)).toBe(12);
    expect(report("vacuum", SUCTION, s, fan)).toBe(0);
    expect(advertised).toContain(0);
  });

  it.each([
    "unavailable",
    "unknown",
  ])("reports Mop on mop select %s while mopping", (s) => {
    expect(report("mop", MOP, "medium", water)).toBe(51);
    expect(report("mop", MOP, s, water)).toBe(2);
    expect(advertised).toContain(2);
  });

  it.each([
    "unavailable",
    "unknown",
  ])("reports nothing on cleaning mode select %s", (s) => {
    const { agent } = agentFor(
      { [CLEAN]: { state: s, attributes: {} } },
      { cleaningModeEntity: CLEAN },
    );
    expect(
      createCleanModeConfig(fan, water, options).getCurrentMode(
        { attributes: {} },
        agent,
      ),
    ).toBeUndefined();
  });
});

describe("clean mode builder limits", () => {
  it("keeps labels unique and within 64 bytes", () => {
    const long = "x".repeat(70);
    const labels = buildSupportedModes(
      ["max_plus", "Max Plus", "vacuum", long],
      water,
      ["vacuum", "mop"],
    ).map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => Buffer.byteLength(l) <= 64)).toBe(true);
    expect(labels.slice(0, 3)).toEqual(["Vacuum", "Mop", "Max Plus"]);
  });

  it("keeps run mode names as clean mode labels", () => {
    const long = "x".repeat(70);
    const labels = buildSupportedModes(
      ["idle", "cleaning", "max_plus", "Max Plus", long],
      water,
      ["vacuum", "mop"],
    ).map((m) => m.label);
    expect(labels.slice(0, 4)).toEqual(["Vacuum", "Mop", "Idle", "Cleaning"]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => Buffer.byteLength(l) <= 64)).toBe(true);
  });

  it("caps fan speeds below the mop intensity ids", () => {
    const many = Array.from({ length: 45 }, (_, i) => `speed_${i}`);
    const modes = buildSupportedModes(many, water, ["vacuum", "mop"]).map(
      (m) => m.mode,
    );
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes.filter((m) => m >= 10 && m < 50)).toHaveLength(40);

    const { agent } = agentFor({}, {});
    const current = createCleanModeConfig(many, water, [
      "vacuum",
      "mop",
    ]).getCurrentMode({ attributes: { fan_speed: "speed_40" } }, agent);
    expect(current).toBe(0);
  });
});

describe("clean mode actions", () => {
  it("sends no other cleaning type when the wanted one has no option", () => {
    const options = ["mop", "vacuum_and_mop"];
    const { agent, actions } = agentFor(
      { [CLEAN]: { state: "mop", attributes: { options } } },
      { cleaningModeEntity: CLEAN },
    );
    const config = createCleanModeConfig(fan, undefined, options);
    expect(config.setCleanMode(0, agent)).toBeUndefined();
    expect(config.setCleanMode(13, agent)).toEqual({
      action: "vacuum.set_fan_speed",
      data: { fan_speed: "turbo" },
      target: "vacuum.murre",
    });
    expect(actions).toEqual([]);
  });

  it("unescapes alias characters when matching a tagged option", () => {
    expect(
      matchTaggedOption("x", ["eco+"], 1, [{ pattern: /^(eco\+)$/, tag: 1 }]),
    ).toBe("eco+");
  });
});
