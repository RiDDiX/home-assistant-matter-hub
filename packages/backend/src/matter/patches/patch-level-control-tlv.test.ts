import { LevelControl } from "@matter/main/clusters/level-control";
import { describe, expect, it } from "vitest";
import { patchLevelControlTlv } from "./patch-level-control-tlv.js";

type LevelControlField = {
  readonly name?: string;
  readonly propertyName?: string;
  readonly mandatory?: boolean;
};

describe("patchLevelControlTlv", () => {
  it("makes transitionTime optional on LevelControl move and step commands", () => {
    patchLevelControlTlv();

    expect(getTransitionTimeField("moveToLevel")?.mandatory).toBe(false);
    expect(getTransitionTimeField("step")?.mandatory).toBe(false);
  });
});

function getTransitionTimeField(command: "moveToLevel" | "step") {
  const fields = LevelControl.commands[command].schema.children as
    | LevelControlField[]
    | undefined;
  return fields?.find(
    (field) =>
      field.name === "TransitionTime" ||
      field.propertyName === "transitionTime",
  );
}
