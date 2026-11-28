import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
  VacuumDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { type Behavior, Endpoint, VendorId } from "@matter/main";
import type { ServiceArea } from "@matter/main/clusters";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { describe, expect, it } from "vitest";
import {
  createCleanAreaServiceAreaServer,
  createCustomServiceAreaServer,
  createDefaultServiceAreaServer,
  createVacuumServiceAreaServer,
  getVacuumServiceAreas,
  withResolvedRooms,
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

describe("custom areas with maps and floors (#506)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: read the seeded initial state
  const defaults = (server: unknown) => (server as any).defaults;
  const shape = (server: unknown) =>
    supportedAreas(server).map((a) => [
      a.areaId,
      a.mapId,
      a.areaInfo.locationInfo?.floorNumber,
    ]);

  it("turns map names into maps and keeps the same room name on two of them", () => {
    const server = createCustomServiceAreaServer([
      { name: "Bath", service: "script.a", mapName: "Ground", floorNumber: 0 },
      {
        name: "Bath",
        service: "script.b",
        mapName: "Upstairs",
        floorNumber: 1,
      },
      {
        name: "Hall",
        service: "script.c",
        mapName: " Ground ",
        floorNumber: -1,
      },
    ]);
    expect(defaults(server).supportedMaps).toEqual([
      { mapId: 1, name: "Ground" },
      { mapId: 2, name: "Upstairs" },
    ]);
    expect(shape(server)).toEqual([
      [1, 1, 0],
      [2, 2, 1],
      [3, 1, -1],
    ]);
  });

  it("drops the maps when one area has none, Matter forbids the mix", () => {
    const server = createCustomServiceAreaServer([
      { name: "Bath", service: "script.a", mapName: "Ground" },
      { name: "Hall", service: "script.b" },
    ]);
    expect(defaults(server).supportedMaps).toBeUndefined();
    expect(shape(server)).toEqual([
      [1, null, null],
      [2, null, null],
    ]);
  });

  it("treats a blank or non string map name as no map", () => {
    const server = createCustomServiceAreaServer([
      { name: "A", service: "script.a", mapName: "Ground" },
      { name: "B", service: "script.b", mapName: "   " },
      // biome-ignore lint/suspicious/noExplicitAny: a hand edited config
      { name: "C", service: "script.c", mapName: 2 as any },
    ]);
    expect(defaults(server).supportedMaps).toBeUndefined();
    expect(shape(server).map((a) => a[1])).toEqual([null, null, null]);
  });

  it("ignores a floor that is not an int16 integer", () => {
    const server = createCustomServiceAreaServer([
      { name: "A", service: "script.a", floorNumber: 1.5 },
      { name: "B", service: "script.b", floorNumber: 40000 },
      // biome-ignore lint/suspicious/noExplicitAny: a hand edited config
      { name: "C", service: "script.c", floorNumber: "2" as any },
      { name: "D", service: "script.d", floorNumber: 32767 },
    ]);
    expect(shape(server)).toEqual([
      [1, null, null],
      [2, null, null],
      [3, null, null],
      [4, null, 32767],
    ]);
  });

  it("cuts a map name to the 64 chars Matter allows", () => {
    const server = createCustomServiceAreaServer([
      { name: "A", service: "script.a", mapName: "m".repeat(80) },
    ]);
    expect(defaults(server).supportedMaps).toEqual([
      { mapId: 1, name: "m".repeat(64) },
    ]);
  });
});

describe("name byte limits", () => {
  const long = "居間".repeat(30); // 180 bytes
  const bytes = (value: string) => Buffer.byteLength(value);

  // A plain device is enough, matter.js validates the cluster state on init
  async function mount(server: Behavior.Type) {
    const dir = mkdtempSync(join(tmpdir(), "hamh-sa-"));
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const node = await ServerNode.create({
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: "sa",
      network: { port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
    });
    try {
      const endpoint = new Endpoint(OnOffPlugInUnitDevice.with(server), {
        id: "v",
      });
      await node.add(endpoint);
      // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
      const state = (endpoint.state as any).serviceArea;
      return {
        maps: state.supportedMaps as ServiceArea.Map[] | undefined,
        areas: state.supportedAreas as ServiceArea.Area[],
      };
    } finally {
      await node.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("mounts a long multi-byte room on a long map within the limits", async () => {
    const attributes = {
      rooms: { ["地図".repeat(15)]: [{ id: 1, name: long }] },
    } as unknown as VacuumDeviceAttributes;
    const { maps, areas } = await mount(
      createVacuumServiceAreaServer(attributes),
    );
    const name = areas[0].areaInfo.locationInfo?.locationName ?? "";
    expect(bytes(name)).toBe(126);
    expect(long.startsWith(name)).toBe(true);
    expect(maps).toEqual([{ mapId: 1, name: `${"地図".repeat(10)}地` }]);
    expect(areas[0].mapId).toBe(1);
    expect(getVacuumServiceAreas(attributes)[0].name).toBe(name);
  });

  it("keeps two cut names that share a prefix apart", async () => {
    const attributes = {
      rooms: { "1": `${long} A`, "2": `${long} B` },
    } as unknown as VacuumDeviceAttributes;
    const { areas } = await mount(createVacuumServiceAreaServer(attributes));
    const names = areas.map((a) => a.areaInfo.locationInfo?.locationName);
    expect(names).toEqual(["居間".repeat(21), `${"居間".repeat(21)} 2`]);
    expect(names.every((n) => bytes(n ?? "") <= 128)).toBe(true);
  });

  it("cuts custom and CLEAN_AREA names the same way the switches see them", async () => {
    const custom = await mount(
      createCustomServiceAreaServer([{ name: long, service: "script.a" }]),
    );
    const clean = await mount(
      createCleanAreaServiceAreaServer([
        { areaId: 7, name: long, haAreaId: "living" },
      ]),
    );
    for (const [{ areas }, mapping] of [
      [custom, { customServiceAreas: [{ name: long, service: "script.a" }] }],
      [
        clean,
        { cleanAreaRooms: [{ areaId: 7, name: long, haAreaId: "living" }] },
      ],
    ] as const) {
      const name = areas[0].areaInfo.locationInfo?.locationName;
      expect(bytes(name ?? "")).toBe(126);
      expect(
        getVacuumServiceAreas(
          {} as VacuumDeviceAttributes,
          mapping as unknown as EntityMappingConfig,
        )[0].name,
      ).toBe(name);
    }
  });
});

describe("withResolvedRooms (#497)", () => {
  const state = (attributes: Record<string, unknown>) =>
    ({ state: "docked", attributes }) as unknown as HomeAssistantEntityState;
  const effective = { state: state({ rooms: { "1": "Kitchen" } }) };

  it("puts resolved rooms back into a live state without room data", () => {
    const next = withResolvedRooms(state({ battery_level: 50 }), effective);
    expect(next.attributes).toEqual({
      battery_level: 50,
      rooms: { "1": "Kitchen" },
    });
  });

  it("leaves a state alone that has its own rooms or nothing to add", () => {
    const own = state({ segments: [{ id: 2, name: "Hall" }] });
    expect(withResolvedRooms(own, effective)).toBe(own);
    const plain = state({ battery_level: 50 });
    expect(withResolvedRooms(plain, undefined)).toBe(plain);
    const empty = {} as HomeAssistantEntityState;
    expect(withResolvedRooms(empty, effective)).toBe(empty);
  });
});
