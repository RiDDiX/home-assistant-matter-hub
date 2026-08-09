import type {
  EntityMappingConfig,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import type { ServiceArea } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import {
  createCleanAreaServiceAreaServer,
  createCustomServiceAreaServer,
  createDefaultServiceAreaServer,
  createVacuumServiceAreaServer,
  getVacuumServiceAreas,
} from "./vacuum-service-area-server.js";

// getVacuumServiceAreas is the single enumeration the #355 room switches and the
// ServiceArea cluster both consume. These lock that the ids/names it returns are
// exactly the supportedAreas the cluster servers build, so the switches can't
// drift from the cluster.

// The behavior factories store their initial supportedAreas under the state seed
// key; read them back to compare against the enumeration.
function supportedAreas(server: unknown): ServiceArea.Area[] {
  // matter.js Behavior.set() stores seed values in the derived State; `.defaults`
  // materializes them.
  // biome-ignore lint/suspicious/noExplicitAny: read the seeded initial state
  return (server as any).defaults.supportedAreas as ServiceArea.Area[];
}

function pairs(areas: { areaId: number; name: string }[]) {
  return areas.map((a) => ({ areaId: a.areaId, name: a.name }));
}

function clusterPairs(areas: ServiceArea.Area[]) {
  return areas.map((a) => ({
    areaId: a.areaId,
    name: a.areaInfo.locationInfo?.locationName ?? "",
  }));
}

describe("getVacuumServiceAreas", () => {
  it("CLEAN_AREA: matches createCleanAreaServiceAreaServer ids and names", () => {
    const cleanAreaRooms = [
      { areaId: 10, name: "Office", haAreaId: "office" },
      { areaId: 11, name: "Hall", haAreaId: "hall" },
    ];
    const mapping = {
      entityId: "vacuum.x",
      cleanAreaRooms,
    } as EntityMappingConfig;
    const enumerated = getVacuumServiceAreas(
      {} as VacuumDeviceAttributes,
      mapping,
    );
    expect(pairs(enumerated)).toEqual(
      clusterPairs(
        supportedAreas(createCleanAreaServiceAreaServer(cleanAreaRooms)),
      ),
    );
    expect(pairs(enumerated)).toEqual([
      { areaId: 10, name: "Office" },
      { areaId: 11, name: "Hall" },
    ]);
  });

  it("custom areas: matches createCustomServiceAreaServer ids (1-based) and names", () => {
    const customServiceAreas = [
      { name: "Zone1", service: "script.z1" },
      { name: "Zone2", service: "script.z2" },
    ];
    const mapping = {
      entityId: "vacuum.x",
      customServiceAreas,
    } as EntityMappingConfig;
    const enumerated = getVacuumServiceAreas(
      {} as VacuumDeviceAttributes,
      mapping,
    );
    expect(pairs(enumerated)).toEqual(
      clusterPairs(
        supportedAreas(createCustomServiceAreaServer(customServiceAreas)),
      ),
    );
    expect(pairs(enumerated)).toEqual([
      { areaId: 1, name: "Zone1" },
      { areaId: 2, name: "Zone2" },
    ]);
  });

  it("attribute rooms: matches createVacuumServiceAreaServer ids and names", () => {
    const attributes = {
      rooms: { "16": "Kitchen", "17": "Bedroom" },
    } as unknown as VacuumDeviceAttributes;
    const enumerated = getVacuumServiceAreas(attributes, undefined);
    expect(pairs(enumerated)).toEqual(
      clusterPairs(supportedAreas(createVacuumServiceAreaServer(attributes))),
    );
    expect(pairs(enumerated)).toEqual([
      { areaId: 16, name: "Kitchen" },
      { areaId: 17, name: "Bedroom" },
    ]);
  });

  it("roomEntities: matches createVacuumServiceAreaServer with button entities", () => {
    const attributes = {} as VacuumDeviceAttributes;
    const roomEntities = ["button.roborock_clean_kitchen"];
    const mapping = {
      entityId: "vacuum.x",
      roomEntities,
    } as EntityMappingConfig;
    const enumerated = getVacuumServiceAreas(attributes, mapping);
    expect(pairs(enumerated)).toEqual(
      clusterPairs(
        supportedAreas(createVacuumServiceAreaServer(attributes, roomEntities)),
      ),
    );
    expect(enumerated).toHaveLength(1);
    expect(enumerated[0].name).toBe("Kitchen");
  });

  it("no rooms: returns [] (default single Home area gets no switches)", () => {
    expect(
      getVacuumServiceAreas({} as VacuumDeviceAttributes, undefined),
    ).toEqual([]);
    // The default cluster still exposes a single Home area, but switches don't.
    expect(supportedAreas(createDefaultServiceAreaServer())).toHaveLength(1);
  });
});
