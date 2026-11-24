import type {
  BridgeFeatureFlags,
  HomeAssistantEntityRegistry,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { resolveNodeLabel } from "./node-label.js";

const alias: BridgeFeatureFlags = { preferEntityAlias: true };
const both: BridgeFeatureFlags = {
  preferEntityAlias: true,
  preferEntityRegistryName: true,
};
const registryName: BridgeFeatureFlags = { preferEntityRegistryName: true };

const entry = (
  fields: Partial<HomeAssistantEntityRegistry>,
): HomeAssistantEntityRegistry => ({
  entity_id: "light.kitchen",
  device_id: "d1",
  ...fields,
});

describe("resolveNodeLabel", () => {
  it.each<
    [
      string,
      string | undefined,
      Partial<HomeAssistantEntityRegistry> | undefined,
      string | undefined,
      BridgeFeatureFlags | undefined,
      string,
    ]
  >([
    [
      "flags off uses friendly_name",
      undefined,
      { aliases: ["Lamp"], name: "Reg" },
      "Kitchen Light",
      {},
      "Kitchen Light",
    ],
    [
      "flags off uses customName",
      "Custom",
      { aliases: ["Lamp"] },
      "Kitchen Light",
      undefined,
      "Custom",
    ],
    [
      "alias wins with the flag",
      undefined,
      { aliases: ["Lamp"] },
      "Kitchen Light",
      alias,
      "Lamp",
    ],
    [
      "null alias is skipped",
      undefined,
      { aliases: [null, "Kitchen light"] },
      "Friendly",
      alias,
      "Kitchen light",
    ],
    [
      "empty alias is skipped",
      undefined,
      { aliases: ["", "Lamp"] },
      "Friendly",
      alias,
      "Lamp",
    ],
    [
      "whitespace alias is skipped",
      undefined,
      { aliases: ["   ", "Lamp"] },
      "Friendly",
      alias,
      "Lamp",
    ],
    [
      "only blank aliases fall through",
      undefined,
      { aliases: [null, " "] },
      "Friendly",
      alias,
      "Friendly",
    ],
    [
      "customName beats the alias",
      "Custom",
      { aliases: ["Lamp"] },
      "Friendly",
      both,
      "Custom",
    ],
    [
      "alias beats registry name",
      undefined,
      { aliases: ["Lamp"], name: "Reg" },
      "Friendly",
      both,
      "Lamp",
    ],
    [
      "no alias falls to registry name",
      undefined,
      { aliases: [], name: "Reg" },
      "Friendly",
      both,
      "Reg",
    ],
    [
      "registry original_name",
      undefined,
      { original_name: "Orig" },
      "Friendly",
      registryName,
      "Orig",
    ],
    [
      "blank registry name falls through",
      undefined,
      { name: "  " },
      "Friendly",
      registryName,
      "Friendly",
    ],
    [
      "no alias falls to friendly_name",
      undefined,
      {},
      "Friendly",
      alias,
      "Friendly",
    ],
    ["no registry entry", undefined, undefined, "Friendly", both, "Friendly"],
    ["entity_id last", "  ", { aliases: [""] }, " ", both, "light.kitchen"],
  ])("%s", (_, customName, registry, friendlyName, flags, expected) => {
    expect(
      resolveNodeLabel(
        customName,
        registry ? entry(registry) : undefined,
        friendlyName,
        "light.kitchen",
        flags,
      ),
    ).toBe(expected);
  });

  it("cuts a CJK alias to 32 bytes without splitting a code point", () => {
    const label = resolveNodeLabel(
      undefined,
      entry({ aliases: ["客厅空调伴侣 插座 电量 统计 传感器 小米"] }),
      "Friendly",
      "light.kitchen",
      alias,
    );
    expect(Buffer.byteLength(label)).toBeLessThanOrEqual(32);
    expect(label).toBe("客厅空调伴侣 插座 电...");
  });
});
