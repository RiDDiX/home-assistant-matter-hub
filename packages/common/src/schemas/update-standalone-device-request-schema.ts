import { JSONSchemaType } from "ajv";
import type { UpdateStandaloneDeviceRequest } from "../standalone-device-data.js";

export const updateStandaloneDeviceRequestSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    port: { type: "integer" },
    filter: { type: "object" }, // Reference HomeAssistantFilter schema if available
    deviceType: { type: "string" },
    entities: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    countryCode: { type: "string", nullable: true },
    icon: { type: "string", nullable: true },
    serialNumberSuffix: { type: "string", nullable: true },
  },
  required: ["id", "name", "port", "filter", "deviceType", "entities"],
  additionalProperties: false,
};
