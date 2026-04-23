import { fetchJson } from "./fetch-utils.ts";

const BASE_URL = "/api/standalone-devices";

export async function getStandaloneDevices() {
  return fetchJson(BASE_URL);
}

export async function getStandaloneDevice(id: string) {
  return fetchJson(`${BASE_URL}/${id}`);
}

export async function createStandaloneDevice(data: any) {
  return fetchJson(BASE_URL, {
    method: "POST",
    body: JSON.stringify(data),
    headers: { "Content-Type": "application/json" },
  });
}

export async function updateStandaloneDevice(id: string, data: any) {
  return fetchJson(`${BASE_URL}/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
    headers: { "Content-Type": "application/json" },
  });
}

export async function deleteStandaloneDevice(id: string) {
  return fetchJson(`${BASE_URL}/${id}`, {
    method: "DELETE",
  });
}
