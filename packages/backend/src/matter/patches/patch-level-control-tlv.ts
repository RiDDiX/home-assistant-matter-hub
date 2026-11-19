/**
 * Runtime patch for Matter.js LevelControl TLV schema.
 *
 * Google Home sends moveToLevel / moveToLevelWithOnOff commands without the
 * transitionTime field when adjusting brightness via the app slider for an
 * already-on light. The Matter spec defines transitionTime as nullable (allowed
 * to be null), but Matter.js marks it as a mandatory TLV field. When the field
 * is completely omitted, Matter.js throws ValidationMandatoryFieldMissingError
 * BEFORE our command handler can provide a default value.
 *
 * This patch sets the field's conformance to optional on the command schemas
 * so that omitted fields pass validation. Our LevelControlServer handler
 * already defaults null/undefined transitionTime to 0 (instant transition).
 *
 * Affects: moveToLevel (moveToLevelWithOnOff inherits its fields)
 *          step (stepWithOnOff inherits its fields)
 *
 * See: https://github.com/RiDDiX/home-assistant-matter-hub/issues/41
 */

import { Logger } from "@matter/general";
import { LevelControl } from "@matter/main/clusters/level-control";

const logger = Logger.get("PatchLevelControlTlv");

type LevelControlField = {
  readonly name?: string;
  readonly propertyName?: string;
  readonly mandatory?: boolean;
  patch?: (definition: { conformance: "O" }) => void;
};

export function patchLevelControlTlv(): void {
  let patched = 0;
  const patchErrors: string[] = [];

  for (const command of ["moveToLevel", "step"] as const) {
    const field = transitionTimeField(command);
    try {
      field?.patch?.({ conformance: "O" });
    } catch (error) {
      patchErrors.push(
        `${command}:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (field?.mandatory === false) {
      patched++;
    }
  }

  if (patched === 2) {
    logger.info(
      `Patched ${patched} LevelControl TLV schema(s): transitionTime is now optional (Google Home compatibility)`,
    );
  } else {
    logger.warn(
      "Failed to patch LevelControl TLV schemas, transitionTime is still mandatory. " +
        "Google Home brightness adjustment may not work.",
      {
        moveToLevel: describeField(transitionTimeField("moveToLevel")),
        patchErrors,
        step: describeField(transitionTimeField("step")),
      },
    );
  }
}

function transitionTimeField(
  command: "moveToLevel" | "step",
): LevelControlField | undefined {
  const fields = LevelControl.commands[command].schema.children as
    | LevelControlField[]
    | undefined;
  return fields?.find(
    (field) =>
      field.name === "TransitionTime" ||
      field.propertyName === "transitionTime",
  );
}

function describeField(field: LevelControlField | undefined) {
  return field
    ? {
        hasPatch: typeof field.patch === "function",
        mandatory: field.mandatory,
      }
    : "not found";
}
