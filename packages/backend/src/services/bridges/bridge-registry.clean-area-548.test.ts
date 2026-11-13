import { VacuumDeviceFeature } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";

// #548: HA allows vacuum/get_segments for admins only and logs an error on
// its side for every refused call.

function sut(isAdmin: boolean | undefined) {
  const sent: string[] = [];
  const client = {
    isAdmin,
    connection: {
      sendMessagePromise: async (message: { type: string }) => {
        sent.push(message.type);
        if (message.type === "config/entity_registry/get") {
          return { options: { vacuum: { area_mapping: { kitchen: ["1"] } } } };
        }
        return [{ id: "1", name: "Kitchen" }];
      },
    },
  } as unknown as HomeAssistantClient;
  const registry = {
    areas: new Map([["kitchen", "Kitchen"]]),
    devices: {},
    entities: {},
    labels: [],
    states: {},
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    featureFlags: {},
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;
  return { registry: new BridgeRegistry(registry, dataProvider, client), sent };
}

describe("BridgeRegistry CLEAN_AREA segments (#548)", () => {
  it("skips get_segments for a non-admin user", async () => {
    const { registry, sent } = sut(false);
    const rooms = await registry.resolveCleanAreaRooms(
      "vacuum.robo",
      VacuumDeviceFeature.CLEAN_AREA,
    );
    expect(sent).not.toContain("vacuum/get_segments");
    expect(rooms.map((r) => r.name)).toEqual(["Kitchen"]);
  });

  it("asks for segments when admin or unknown", async () => {
    for (const isAdmin of [true, undefined]) {
      const { registry, sent } = sut(isAdmin);
      await registry.resolveCleanAreaRooms(
        "vacuum.robo",
        VacuumDeviceFeature.CLEAN_AREA,
      );
      expect(sent).toContain("vacuum/get_segments");
    }
  });
});
