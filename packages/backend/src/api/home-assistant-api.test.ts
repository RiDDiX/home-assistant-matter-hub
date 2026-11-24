import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { homeAssistantApi } from "./home-assistant-api.js";

const registry = {
  entities: {
    "camera.front": { entity_id: "camera.front", device_id: "d1" },
  },
  devices: { d1: { id: "d1", name: "Front door" } },
  states: {
    "camera.front": {
      entity_id: "camera.front",
      state: "idle",
      attributes: {
        friendly_name: "Front door",
        brand: "Reolink",
        access_token: "cafe1234",
        entity_picture: "/api/camera_proxy/camera.front?token=cafe1234",
      },
    },
  },
} as unknown as HomeAssistantRegistry;

async function get(path: string): Promise<string> {
  const app = express();
  app.use(
    "/ha",
    homeAssistantApi(registry, {} as unknown as HomeAssistantClient),
  );
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/ha/${path}`);
    expect(res.status).toBe(200);
    return await res.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("homeAssistantApi camera attributes", () => {
  it.each([
    "entities?domain=camera",
    "entities/camera.front",
    "devices/d1",
  ])("GET %s keeps the camera token out", async (path) => {
    const body = await get(path);

    expect(body).not.toContain("cafe1234");
    expect(body).toContain('"access_token":"[redacted]"');
    expect(body).toContain('"entity_picture":"[redacted]"');
    expect(body).toContain('"friendly_name":"Front door"');
    expect(body).toContain('"brand":"Reolink"');
  });
});
