// Fetch Home Assistant entity IDs for auto-complete
export interface HomeAssistantEntity {
  entity_id: string;
  friendly_name?: string;
  domain: string;
  device_id?: string;
  device_name?: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface EntityListResponse {
  total: number;
  limit: number;
  offset: number;
  entities: HomeAssistantEntity[];
}

export async function fetchEntityList({
  search = "",
  limit = 100,
} = {}): Promise<HomeAssistantEntity[]> {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  const res = await fetch(`/api/home-assistant/entities?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch entity list");
  const data: EntityListResponse = await res.json();
  return data.entities;
}
