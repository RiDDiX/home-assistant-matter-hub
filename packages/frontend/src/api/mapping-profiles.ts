import type {
  MappingProfile,
  MappingProfileImportPreview,
  MappingProfileImportResult,
} from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export async function exportMappingProfile(
  bridgeId: string,
  profileName: string,
  entityIds?: string[],
): Promise<MappingProfile> {
  const params = new URLSearchParams({ name: profileName });
  if (entityIds?.length) {
    params.set("entityIds", entityIds.join(","));
  }
  const response = await fetch(
    `api/mapping-profiles/export/${bridgeId}?${params.toString()}`,
  );
  await assertOk(response, "Failed to export mapping profile");
  return parseJsonResponse(response);
}

export async function previewMappingProfileImport(
  bridgeId: string,
  profile: MappingProfile,
  availableEntityIds: string[],
): Promise<MappingProfileImportPreview> {
  const response = await fetch(
    `api/mapping-profiles/import/preview/${bridgeId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, availableEntityIds }),
    },
  );
  await assertOk(response, "Failed to preview import");
  return parseJsonResponse(response);
}

export async function applyMappingProfileImport(
  bridgeId: string,
  profile: MappingProfile,
  selectedEntityIds: string[],
): Promise<MappingProfileImportResult> {
  const response = await fetch(
    `api/mapping-profiles/import/apply/${bridgeId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, selectedEntityIds }),
    },
  );
  await assertOk(response, "Failed to apply mapping profile");
  return parseJsonResponse(response);
}
