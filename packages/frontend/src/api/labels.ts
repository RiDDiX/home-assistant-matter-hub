import { assertOk, parseJsonResponse } from "./fetch-utils.js";

export interface HomeAssistantLabel {
  label_id: string;
  name: string;
  icon?: string;
  color?: string;
}

export interface HomeAssistantArea {
  area_id: string;
  name: string;
}

export async function fetchLabels(): Promise<HomeAssistantLabel[]> {
  const res = await fetch(`api/matter/labels?_s=${Date.now()}`);
  await assertOk(res, "Failed to fetch labels");
  return parseJsonResponse(res);
}

export async function fetchAreas(): Promise<HomeAssistantArea[]> {
  const res = await fetch(`api/matter/areas?_s=${Date.now()}`);
  await assertOk(res, "Failed to fetch areas");
  return parseJsonResponse(res);
}

export interface FilterValues {
  domains: string[];
  platforms: string[];
  entityCategories: string[];
  deviceClasses: string[];
  deviceNames: string[];
  productNames: string[];
}

export async function fetchFilterValues(): Promise<FilterValues> {
  const res = await fetch(`api/matter/filter-values?_s=${Date.now()}`);
  await assertOk(res, "Failed to fetch filter values");
  return parseJsonResponse(res);
}
