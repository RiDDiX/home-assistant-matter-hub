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
 * This patch makes transitionTime optional at the TLV schema level so that
 * omitted fields pass validation. Our LevelControlServer handler already
 * defaults null/undefined transitionTime to 0 (instant transition).
 *
 * Affects: TlvMoveToLevelRequest (moveToLevel + moveToLevelWithOnOff)
 *          TlvStepRequest (step + stepWithOnOff)
 *
 * See: https://github.com/RiDDiX/home-assistant-matter-hub/issues/41
 */

import { Logger } from "@matter/general";
import { LevelControl } from "@matter/main/clusters/level-control";

const logger = Logger.get("PatchLevelControlTlv");

type LevelControlField = {
  readonly name?: string;
  readonly propertyName?: string;
  optional?: boolean;
  readonly mandatory?: boolean;
  patch?: (definition: { conformance: "O" }) => void;
};

const optionalFieldModels = new WeakSet<object>();
let fieldModelMandatoryGetterPatched = false;

export function patchLevelControlTlv(): void {
  let patched = 0;
  const patchErrors: string[] = [];

  const markOptional = (field: LevelControlField | undefined): boolean => {
    if (!field) {
      return false;
    }

    try {
      if (typeof field.patch === "function") {
        field.patch({ conformance: "O" });
      }
    } catch (error) {
      patchErrors.push(formatPatchError("patch", error));
    }

    try {
      field.optional = true;
    } catch (error) {
      patchErrors.push(formatPatchError("optional", error));
    }

    try {
      Object.defineProperty(field, "mandatory", {
        configurable: true,
        value: false,
        writable: true,
      });
    } catch (error) {
      patchErrors.push(formatPatchError("mandatory", error));
    }

    return field.mandatory === false || forceOptionalViaPrototype(field);
  };

  // Older Matter.js builds expose mutable fieldDefinitions on the request types.
  const moveToLevelFields = (
    LevelControl.MoveToLevelRequest as unknown as {
      fieldDefinitions?: Record<string, LevelControlField>;
    }
  ).fieldDefinitions;

  if (markOptional(moveToLevelFields?.transitionTime)) {
    patched++;
  }

  const stepFields = (
    LevelControl.StepRequest as unknown as {
      fieldDefinitions?: Record<string, LevelControlField>;
    }
  ).fieldDefinitions;

  if (markOptional(stepFields?.transitionTime)) {
    patched++;
  }

  // Matter.js 0.17 exposes finalized request fields through command schemas.
  // moveToLevelWithOnOff and stepWithOnOff share these request schemas.
  const moveToLevelSchemaField = findTransitionTimeField(
    LevelControl.commands.moveToLevel.schema.children as
      | LevelControlField[]
      | undefined,
    1,
  );

  if (markOptional(moveToLevelSchemaField)) {
    patched++;
  }

  const stepSchemaField = findTransitionTimeField(
    LevelControl.commands.step.schema.children as
      | LevelControlField[]
      | undefined,
    2,
  );

  if (markOptional(stepSchemaField)) {
    patched++;
  }

  if (patched > 0) {
    logger.info(
      `Patched ${patched} LevelControl TLV schema(s): transitionTime is now optional (Google Home compatibility)`,
    );
  } else {
    logger.warn(
      "Failed to patch LevelControl TLV schemas, field definitions not found. " +
        "Google Home brightness adjustment may not work.",
      {
        moveToLevel: describeFields(
          LevelControl.commands.moveToLevel.schema.children as
            | LevelControlField[]
            | undefined,
        ),
        patchErrors,
        step: describeFields(
          LevelControl.commands.step.schema.children as
            | LevelControlField[]
            | undefined,
        ),
      },
    );
  }
}

function findTransitionTimeField(
  fields: LevelControlField[] | undefined,
  fallbackIndex: number,
): LevelControlField | undefined {
  return (
    fields?.find(
      (field) =>
        field.name === "TransitionTime" ||
        field.propertyName === "transitionTime",
    ) ?? fields?.[fallbackIndex]
  );
}

function forceOptionalViaPrototype(field: LevelControlField & object): boolean {
  optionalFieldModels.add(field);

  if (!fieldModelMandatoryGetterPatched) {
    let proto = Object.getPrototypeOf(field);
    while (proto) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "mandatory");
      if (descriptor?.get && descriptor.configurable) {
        const original = descriptor.get;
        Object.defineProperty(proto, "mandatory", {
          configurable: true,
          get(this: object) {
            if (optionalFieldModels.has(this)) {
              return false;
            }
            return original.call(this);
          },
        });
        fieldModelMandatoryGetterPatched = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
  }

  return field.mandatory === false;
}

function describeFields(fields: LevelControlField[] | undefined) {
  return fields?.map((field, index) => ({
    hasPatch: typeof field.patch === "function",
    index,
    mandatory: field.mandatory,
    name: field.name,
    optional: field.optional,
    propertyName: field.propertyName,
  }));
}

function formatPatchError(action: string, error: unknown): string {
  return `${action}:${error instanceof Error ? error.message : String(error)}`;
}
