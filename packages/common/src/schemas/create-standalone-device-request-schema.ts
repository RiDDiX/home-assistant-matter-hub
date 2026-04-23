import { JSONSchemaType } from "ajv";
import type { CreateStandaloneDeviceRequest } from "../standalone-device-data.js";

export const createStandaloneDeviceRequestSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    port: { type: "integer" },
    filter: { type: "object" }, // You may want to reference the HomeAssistantFilter schema
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
  required: ["name", "port", "filter", "deviceType", "entities"],
  additionalProperties: false,
};
