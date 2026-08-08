import type { EndpointData } from "@home-assistant-matter-hub/common";
import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export async function fetchDevices(bridgeId: string) {
  const response = await fetch(`api/matter/bridges/${bridgeId}/devices`);
  await assertOk(response, "Failed to fetch devices");
  return parseJsonResponse<EndpointData>(response);
}
