import type {
  EntityMappingConfig,
  EntityMappingRequest,
  EntityMappingResponse,
} from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export async function fetchEntityMappings(
  bridgeId: string,
): Promise<EntityMappingResponse> {
  const response = await fetch(`api/entity-mappings/${bridgeId}`);
  await assertOk(response, "Failed to fetch entity mappings");
  return parseJsonResponse(response);
}

export async function updateEntityMapping(
  bridgeId: string,
  entityId: string,
  config: Partial<EntityMappingRequest>,
): Promise<EntityMappingConfig> {
  const response = await fetch(
    `api/entity-mappings/${bridgeId}/${encodeURIComponent(entityId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  await assertOk(response, "Failed to update entity mapping");
  return parseJsonResponse(response);
}

export async function deleteEntityMapping(
  bridgeId: string,
  entityId: string,
): Promise<void> {
  const response = await fetch(
    `api/entity-mappings/${bridgeId}/${encodeURIComponent(entityId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`Failed to delete entity mapping: ${response.statusText}`);
  }
}
