import type { JSONSchema7 } from "json-schema";
import { bridgeConfigSchema } from "./bridge-config-schema.js";

export const updateBridgeRequestSchema: JSONSchema7 = {
  ...bridgeConfigSchema,
  properties: {
    ...bridgeConfigSchema.properties,
    id: {
      type: "string",
      pattern: "^[\\w-]+$",
    },
  },
  required: [...(bridgeConfigSchema?.required ?? []), "id"],
};
