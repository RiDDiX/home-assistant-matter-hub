import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { matterApi } from "./matter-api.js";

const entity = (entity_id: string, extra: Record<string, unknown> = {}) => ({
  entity_id,
  ...extra,
});

const registry = {
  entities: Object.fromEntries(
    [
      ...Array.from({ length: 120 }, (_, i) =>
        entity(`light.l${String(i).padStart(3, "0")}`),
      ),
      entity("vacuum.robot"),
      entity("light.disabled", { disabled_by: "integration" }),
      entity("light.hidden", { hidden_by: "integration" }),
    ].map((e) => [e.entity_id, e]),
  ),
  devices: {},
  states: {},
  labels: [],
} as unknown as HomeAssistantRegistry;

async function preview(body: unknown) {
  const app = express();
  app.use(express.json());
  app.use("/matter", matterApi({} as BridgeService, registry));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/matter/filter-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const filter = {
  include: [
    { type: "domain", value: "light" },
    { type: "domain", value: "vacuum" },
  ],
  exclude: [],
};

describe("POST /filter-preview", () => {
  it("counts domains over every match and skips disabled and hidden entities", async () => {
    const result = await preview(filter);

    expect(result.total).toBe(121);
    expect(result.entities).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.domains).toEqual({ light: 120, vacuum: 1 });
  });

  it("keeps hidden entities when the bridge includes them", async () => {
    const result = await preview({ ...filter, includeHiddenEntities: true });

    expect(result.domains).toEqual({ light: 121, vacuum: 1 });
  });
});
