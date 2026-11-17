import type {
  BridgeFeatureFlags,
  HomeAssistantEntityRegistry,
} from "@home-assistant-matter-hub/common";
import { trimToLength } from "./trim-to-length.js";

// The one nodeLabel chain for bridge and server mode (#276, #555)
export function resolveNodeLabel(
  customName: string | undefined,
  registry: HomeAssistantEntityRegistry | undefined,
  friendlyName: string | undefined,
  entityId: string,
  featureFlags: BridgeFeatureFlags | undefined,
): string {
  const alias = featureFlags?.preferEntityAlias
    ? registry?.aliases?.find((a) => typeof a === "string" && a.trim() !== "")
    : undefined;
  const registryNames = featureFlags?.preferEntityRegistryName
    ? [registry?.name, registry?.original_name]
    : [];
  for (const name of [customName, alias, ...registryNames, friendlyName]) {
    const label = trimToLength(name, 32, "...");
    if (label) return label;
  }
  return trimToLength(entityId, 32, "...") ?? entityId;
}
