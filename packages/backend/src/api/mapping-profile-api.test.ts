import type { AddressInfo } from "node:net";
import type { MappingProfileEntry } from "@home-assistant-matter-hub/common";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import {
  mappingProfileApi,
  matchProfileEntries,
} from "./mapping-profile-api.js";

const entry = (entityIdPattern: string): MappingProfileEntry =>
  ({
    domain: entityIdPattern.split(".")[0],
    entityIdPattern,
    customName: entityIdPattern,
  }) as MappingProfileEntry;

describe("matchProfileEntries", () => {
  it("matches exact ids, then the only entity of a domain", () => {
    const { matches, unmatchedEntries } = matchProfileEntries(
      [entry("switch.coffee"), entry("light.floor"), entry("fan.attic")],
      ["switch.coffee", "light.kitchen", "fan.a", "fan.b"],
    );

    expect(matches.map((m) => [m.matchedEntityId, m.matchType])).toEqual([
      ["switch.coffee", "exact"],
      ["light.kitchen", "domain"],
    ]);
    expect(unmatchedEntries.map((e) => e.entityIdPattern)).toEqual([
      "fan.attic",
    ]);
  });

  it("never hands one target to two entries", () => {
    const { matches, unmatchedEntries } = matchProfileEntries(
      [entry("light.other"), entry("light.kitchen")],
      ["light.kitchen", "light.kitchen"],
    );

    expect(matches).toEqual([
      expect.objectContaining({
        matchedEntityId: "light.kitchen",
        matchType: "exact",
      }),
    ]);
    expect(unmatchedEntries.map((e) => e.entityIdPattern)).toEqual([
      "light.other",
    ]);
  });
});

describe("POST /import/apply", () => {
  it("writes a selected domain match to the matched entity", async () => {
    const setMapping = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    app.use(
      "/profiles",
      mappingProfileApi({ setMapping } as unknown as EntityMappingStorage),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(
        `http://127.0.0.1:${port}/profiles/import/apply/b1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profile: {
              entries: [entry("light.floor"), entry("switch.coffee")],
            },
            selectedEntityIds: ["light.kitchen"],
          }),
        },
      );

      expect(await res.json()).toEqual({ applied: 1, skipped: 1, errors: [] });
      expect(setMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgeId: "b1",
          entityId: "light.kitchen",
          customName: "light.floor",
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("export then import", () => {
  it("round-trips every mapping field", async () => {
    const setMapping = vi.fn().mockResolvedValue(undefined);
    const mapping = {
      entityId: "select.boiler",
      selectExposeAsSwitch: true,
      selectSwitchOnOption: "on",
      composedEntities: [{ entityId: "sensor.boiler_temp" }],
    };
    const app = express();
    app.use(express.json());
    app.use(
      "/profiles",
      mappingProfileApi({
        getMappingsForBridge: () => [mapping],
        setMapping,
      } as unknown as EntityMappingStorage),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}/profiles`;
      const profile = await (await fetch(`${base}/export/b1`)).json();
      await fetch(`${base}/import/apply/b2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, selectedEntityIds: ["select.boiler"] }),
      });

      expect(setMapping).toHaveBeenCalledWith({ ...mapping, bridgeId: "b2" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
