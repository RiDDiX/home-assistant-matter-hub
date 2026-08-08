import { bridgeConfigSchema } from "./bridge-config-schema.js";

// Port is optional on create, the backend assigns the next free one. This
// closes the race where two clients fetch the same next-port suggestion.
export const createBridgeRequestSchema = {
  ...bridgeConfigSchema,
  required: ["name", "filter"],
};
