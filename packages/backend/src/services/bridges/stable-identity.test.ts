import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BridgeStatus,
  type EntityMappingConfig,
  type HomeAssistantEntityRegistry,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { Environment, type Logger, VariableService } from "@matter/general";
import { VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matterApi } from "../../api/matter-api.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../home-assistant/home-assistant-config.js";
import type {
  EntityIdentityStorage,
  IdentityRecord,
} from "../storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../storage/entity-mapping-storage.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { EntityStateProvider } from "./entity-state-provider.js";
import { IdentityResolver, identityKey } from "./identity-resolver.js";

// #404 flagship: renaming an HA entity must not re-mint the Matter device.

const md5 = (v: string) =>
  crypto.createHash("md5").update(v).digest("hex").substring(0, 32);

function reg(unique_id: string, platform: string): HomeAssistantEntityRegistry {
  return { unique_id, platform } as HomeAssistantEntityRegistry;
}

// --- in-memory storage fakes ---

class FakeIdentityStorage {
  private m = new Map<string, Map<string, IdentityRecord>>();
  getIdentity(b: string, k: string) {
    return this.m.get(b)?.get(k);
  }
  getBridgeIdentities(b: string) {
    return this.m.get(b) ?? new Map<string, IdentityRecord>();
  }
  setIdentity(b: string, k: string, r: IdentityRecord) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(k, r);
  }
  markIdentityMissing(b: string, k: string, nowIso: string) {
    const r = this.m.get(b)?.get(k);
    if (!r || r.missingSince != null) return;
    r.missingSince = nowIso;
  }
  clearIdentityMissing(b: string, k: string) {
    const r = this.m.get(b)?.get(k);
    if (!r || r.missingSince == null) return;
    r.missingSince = undefined;
  }
  async deleteIdentity(b: string, k: string) {
    this.m.get(b)?.delete(k);
  }
  async deleteBridgeIdentities(b: string) {
    this.m.delete(b);
  }
}

class FakeMappingStorage {
  private m = new Map<
    string,
    Map<string, EntityMappingConfig & { missingSince?: string }>
  >();
  put(b: string, cfg: EntityMappingConfig) {
    let bm = this.m.get(b);
    if (!bm) {
      bm = new Map();
      this.m.set(b, bm);
    }
    bm.set(cfg.entityId, cfg);
  }
  getMapping(b: string, e: string) {
    return this.m.get(b)?.get(e);
  }
  getMappingsForBridge(b: string) {
    return [...(this.m.get(b)?.values() ?? [])];
  }
  markMappingMissing(b: string, e: string, nowIso: string) {
    const r = this.m.get(b)?.get(e);
    if (!r || r.missingSince != null) return;
    r.missingSince = nowIso;
  }
  clearMappingMissing(b: string, e: string) {
    const r = this.m.get(b)?.get(e);
    if (!r || r.missingSince == null) return;
    r.missingSince = undefined;
  }
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the request shape loosely
  async setMapping(req: any) {
    const { bridgeId, ...cfg } = req;
    this.put(bridgeId, cfg as EntityMappingConfig);
    return cfg as EntityMappingConfig;
  }
  async deleteMapping(b: string, e: string) {
    this.m.get(b)?.delete(e);
  }
  async deleteBridgeMappings(b: string) {
    this.m.delete(b);
  }
}

function asIdentity(s: FakeIdentityStorage) {
  return s as unknown as EntityIdentityStorage;
}
function asMapping(s: FakeMappingStorage) {
  return s as unknown as EntityMappingStorage;
}

// --- resolver unit tests ---

describe("IdentityResolver", () => {
  const noCollide = (stable: boolean) => ({
    stableIdentity: stable,
    isEndpointIdTaken: () => false,
  });

  it("FLOW 3: no unique_id keeps the entity_id derivation and writes no record", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const res = await resolver.resolveIdentity(
      "b",
      { entity_id: "light.x" },
      undefined,
      noCollide(true),
    );
    expect(res).toEqual({
      endpointId: "light_x",
      anchorEntityId: "light.x",
      protected: false,
    });
  });

  it("keyless entities keep the entity_id derivation in a pass unless a keyed record holds the id", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const mapping = (e: string) =>
      e === "light.x" || e === "light.y"
        ? { entityId: e, customName: "Same" }
        : undefined;
    const ids = async (
      stable: boolean,
      entities: { entity_id: string; registry?: HomeAssistantEntityRegistry }[],
    ) =>
      Object.fromEntries(
        [
          ...(await resolver.resolveIdentities(
            "b",
            entities,
            mapping,
            stable,
            fakeLogger(),
          )),
        ].map(([e, r]) => [e, r.endpointId]),
      );

    // two keyless entities on one derived id, and one without a clash
    expect(
      await ids(true, [
        { entity_id: "light.x" },
        { entity_id: "light.y" },
        { entity_id: "light.z" },
      ]),
    ).toEqual({ "light.x": "Same", "light.y": "Same", "light.z": "light_z" });
    expect(id.getBridgeIdentities("b").size).toBe(0);

    // flag off: a keyless entity on a frozen id keeps the live derivation
    id.setIdentity(
      "b",
      identityKey({ entity_id: "light.b", registry: reg("UX", "hue") })!,
      {
        endpointId: "light_a",
        anchorEntityId: "light.a",
        lastEntityId: "light.a",
      },
    );
    expect(
      await ids(false, [
        { entity_id: "light.a" },
        { entity_id: "light.b", registry: reg("UX", "hue") },
      ]),
    ).toEqual({ "light.a": "light_a", "light.b": "light_b" });
  });

  it("grandfathering: seeds while off, then consumes the same id when flipped on (3)", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const entity = {
      entity_id: "light.gf",
      registry: reg("U", "hue"),
    };
    const off = await resolver.resolveIdentity(
      "b",
      entity,
      undefined,
      noCollide(false),
    );
    expect(off).toEqual({
      endpointId: "light_gf",
      anchorEntityId: "light.gf",
      protected: false,
    });
    const key = identityKey(entity)!;
    expect(id.getIdentity("b", key)?.endpointId).toBe("light_gf");

    const on = await resolver.resolveIdentity(
      "b",
      entity,
      undefined,
      noCollide(true),
    );
    expect(on.endpointId).toBe("light_gf");
    expect(on.anchorEntityId).toBe("light.gf");
    expect(on.protected).toBe(true);
  });

  it("re-keys the mapping on rename and never moves the anchor (6)", async () => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const key = identityKey({
      entity_id: "light.old",
      registry: reg("U", "hue"),
    })!;
    id.setIdentity("b", key, {
      endpointId: "light_old",
      anchorEntityId: "light.old",
      lastEntityId: "light.old",
    });
    map.put("b", { entityId: "light.old", customName: "Lamp" });

    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));
    const res = await resolver.resolveIdentity(
      "b",
      { entity_id: "light.new", registry: reg("U", "hue") },
      undefined,
      noCollide(true),
    );

    expect(res.endpointId).toBe("light_old");
    expect(res.anchorEntityId).toBe("light.old");
    expect(res.protected).toBe(true);
    expect(res.renamedFrom).toBe("light.old");
    expect(map.getMapping("b", "light.new")).toMatchObject({
      entityId: "light.new",
      customName: "Lamp",
    });
    expect(map.getMapping("b", "light.old")).toBeUndefined();
    expect(id.getIdentity("b", key)?.lastEntityId).toBe("light.new");
  });

  it("a failed mapping re-key leaves the record on the old entity_id and the next pass retries (#543)", async () => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const entity = { entity_id: "light.new", registry: reg("U", "hue") };
    const key = identityKey(entity)!;
    id.setIdentity("b", key, {
      endpointId: "light_old",
      anchorEntityId: "light.old",
      lastEntityId: "light.old",
    });
    map.put("b", { entityId: "light.old", customName: "Lamp" });
    vi.spyOn(map, "setMapping").mockRejectedValueOnce(new Error("disk full"));
    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));
    const pass = () =>
      resolver.resolveIdentities(
        "b",
        [entity],
        (e) => map.getMapping("b", e),
        true,
        fakeLogger(),
      );

    await expect(pass()).rejects.toThrow("disk full");
    expect(id.getIdentity("b", key)?.lastEntityId).toBe("light.old");
    expect(map.getMapping("b", "light.old")?.customName).toBe("Lamp");

    const res = (await pass()).get("light.new");
    expect(res).toMatchObject({
      endpointId: "light_old",
      renamedFrom: "light.old",
    });
    expect(map.getMapping("b", "light.new")).toMatchObject({
      entityId: "light.new",
      customName: "Lamp",
    });
    expect(map.getMapping("b", "light.old")).toBeUndefined();
    expect(id.getIdentity("b", key)?.lastEntityId).toBe("light.new");
  });

  it("two entities swapping entity_ids in one pass keep their own mappings (#543)", async () => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const a = { entity_id: "light.b", registry: reg("UA", "hue") };
    const b = { entity_id: "light.a", registry: reg("UB", "hue") };
    id.setIdentity("b", identityKey(a)!, {
      endpointId: "light_a",
      anchorEntityId: "light.a",
      lastEntityId: "light.a",
    });
    id.setIdentity("b", identityKey(b)!, {
      endpointId: "light_b",
      anchorEntityId: "light.b",
      lastEntityId: "light.b",
    });
    map.put("b", { entityId: "light.a", customName: "A" });
    map.put("b", { entityId: "light.b", customName: "B" });
    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));

    const res = await resolver.resolveIdentities(
      "b",
      [a, b],
      (e) => map.getMapping("b", e),
      true,
      fakeLogger(),
    );

    expect(res.get("light.b")).toMatchObject({
      endpointId: "light_a",
      renamedFrom: "light.a",
    });
    expect(res.get("light.a")).toMatchObject({
      endpointId: "light_b",
      renamedFrom: "light.b",
    });
    expect(map.getMapping("b", "light.b")).toMatchObject({
      entityId: "light.b",
      customName: "A",
    });
    expect(map.getMapping("b", "light.a")).toMatchObject({
      entityId: "light.a",
      customName: "B",
    });
    expect(id.getIdentity("b", identityKey(a)!)?.lastEntityId).toBe("light.b");
    expect(id.getIdentity("b", identityKey(b)!)?.lastEntityId).toBe("light.a");
  });

  it.each([
    ["a swap", "light.b", "light.a", "light.b"],
    ["a shift chain", "light.b", "light.c", "light.b"],
  ])("%s with one mapping moves it once (#543)", async (_name, aTo, bTo, want) => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const a = { entity_id: aTo, registry: reg("UA", "hue") };
    const b = { entity_id: bTo, registry: reg("UB", "hue") };
    id.setIdentity("b", identityKey(a)!, {
      endpointId: "light_a",
      anchorEntityId: "light.a",
      lastEntityId: "light.a",
    });
    id.setIdentity("b", identityKey(b)!, {
      endpointId: "light_b",
      anchorEntityId: "light.b",
      lastEntityId: "light.b",
    });
    map.put("b", { entityId: "light.a", customName: "A" });
    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));

    await resolver.resolveIdentities(
      "b",
      [a, b],
      (e) => map.getMapping("b", e),
      true,
      fakeLogger(),
    );

    expect(map.getMappingsForBridge("b")).toEqual([
      { entityId: want, customName: "A" },
    ]);
  });

  it("a swap whose second write fails is put back, so the retry does not swap it back (#543)", async () => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const a = { entity_id: "light.b", registry: reg("UA", "hue") };
    const b = { entity_id: "light.a", registry: reg("UB", "hue") };
    id.setIdentity("b", identityKey(a)!, {
      endpointId: "light_a",
      anchorEntityId: "light.a",
      lastEntityId: "light.a",
    });
    id.setIdentity("b", identityKey(b)!, {
      endpointId: "light_b",
      anchorEntityId: "light.b",
      lastEntityId: "light.b",
    });
    map.put("b", { entityId: "light.a", customName: "A" });
    map.put("b", { entityId: "light.b", customName: "B" });
    // like the real storage: memory changes, then the file write fails
    const setMapping = map.setMapping.bind(map);
    let calls = 0;
    // biome-ignore lint/suspicious/noExplicitAny: mirrors the request shape loosely
    vi.spyOn(map, "setMapping").mockImplementation(async (req: any) => {
      const cfg = await setMapping(req);
      if (++calls === 2) throw new Error("disk full");
      return cfg;
    });
    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));
    const pass = () =>
      resolver.resolveIdentities(
        "b",
        [a, b],
        (e) => map.getMapping("b", e),
        true,
        fakeLogger(),
      );

    await expect(pass()).rejects.toThrow("disk full");
    expect(map.getMapping("b", "light.a")?.customName).toBe("A");
    expect(map.getMapping("b", "light.b")?.customName).toBe("B");
    expect(id.getIdentity("b", identityKey(a)!)?.lastEntityId).toBe("light.a");

    await pass();
    expect(map.getMapping("b", "light.b")?.customName).toBe("A");
    expect(map.getMapping("b", "light.a")?.customName).toBe("B");
    expect(id.getIdentity("b", identityKey(a)!)?.lastEntityId).toBe("light.b");
  });

  it("does not re-key the mapping on rename when the flag is off, but still tracks lastEntityId (finding 2)", async () => {
    const id = new FakeIdentityStorage();
    const map = new FakeMappingStorage();
    const key = identityKey({
      entity_id: "light.old",
      registry: reg("U", "hue"),
    })!;
    id.setIdentity("b", key, {
      endpointId: "light_old",
      anchorEntityId: "light.old",
      lastEntityId: "light.old",
    });
    map.put("b", { entityId: "light.old", customName: "Lamp" });

    const resolver = new IdentityResolver(asIdentity(id), asMapping(map));
    const res = await resolver.resolveIdentity(
      "b",
      { entity_id: "light.new", registry: reg("U", "hue") },
      undefined,
      noCollide(false),
    );

    // flag off: today's live derivation, no re-key of the mapping
    expect(res.protected).toBe(false);
    expect(res.endpointId).toBe("light_new");
    expect(map.getMapping("b", "light.old")).toMatchObject({
      customName: "Lamp",
    });
    expect(map.getMapping("b", "light.new")).toBeUndefined();
    // lastEntityId tracking stays unconditional so a later flip-on is correct
    expect(id.getIdentity("b", key)?.lastEntityId).toBe("light.new");
  });

  it("flag off: a rename re-seeds the record so a later flip-on is a no-op (finding 1a)", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const old = { entity_id: "light.old", registry: reg("U", "hue") };
    const key = identityKey(old)!;

    // seed while off, then rename while still off
    await resolver.resolveIdentity("b", old, undefined, noCollide(false));
    const renamed = { entity_id: "light.new", registry: reg("U", "hue") };
    const offAfter = await resolver.resolveIdentity(
      "b",
      renamed,
      undefined,
      noCollide(false),
    );
    expect(offAfter.endpointId).toBe("light_new");
    // the record must now match the live post-rename derivation, not the seed
    expect(id.getIdentity("b", key)?.endpointId).toBe("light_new");
    expect(id.getIdentity("b", key)?.anchorEntityId).toBe("light.new");

    // flipping on returns the current derivation, never the stale seed
    const on = await resolver.resolveIdentity(
      "b",
      renamed,
      undefined,
      noCollide(true),
    );
    expect(on.endpointId).toBe("light_new");
    expect(on.anchorEntityId).toBe("light.new");
    expect(on.protected).toBe(true);
  });

  it("flag off: a customName change re-seeds the record so a later flip-on is a no-op (finding 1b)", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const entity = { entity_id: "switch.x", registry: reg("U", "hue") };
    const key = identityKey(entity)!;

    // seed while off with no customName
    await resolver.resolveIdentity("b", entity, undefined, noCollide(false));
    expect(id.getIdentity("b", key)?.endpointId).toBe("switch_x");

    // give it a customName while still off: the live endpoint id follows the name
    const named = { entityId: "switch.x", customName: "Kitchen" };
    const offAfter = await resolver.resolveIdentity(
      "b",
      entity,
      named,
      noCollide(false),
    );
    expect(offAfter.endpointId).toBe("Kitchen");
    expect(id.getIdentity("b", key)?.endpointId).toBe("Kitchen");
    expect(id.getIdentity("b", key)?.anchorEntityId).toBe("switch.x");

    // flip on: the frozen id is the current derivation, not the stale seed
    const on = await resolver.resolveIdentity(
      "b",
      entity,
      named,
      noCollide(true),
    );
    expect(on.endpointId).toBe("Kitchen");
    expect(on.protected).toBe(true);
  });

  it("suffixes a colliding endpoint id only when protected (8)", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const taken = new Set(["light_x"]);
    const res = await resolver.resolveIdentity(
      "b",
      { entity_id: "light.x", registry: reg("U2", "hue") },
      undefined,
      { stableIdentity: true, isEndpointIdTaken: (eid) => taken.has(eid) },
    );
    expect(res.endpointId).toBe("light_x_2");
    expect(res.protected).toBe(true);
  });

  it("re-pair recipe: a new unique_id on an old entity_id reuses the old id, dormant record untouched (9)", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const key1 = identityKey({
      entity_id: "light.a",
      registry: reg("U1", "hue"),
    })!;
    id.setIdentity("b", key1, {
      endpointId: "light_a",
      anchorEntityId: "light.a",
      lastEntityId: "light.a",
    });

    const res = await resolver.resolveIdentity(
      "b",
      { entity_id: "light.a", registry: reg("U2", "hue") },
      undefined,
      noCollide(true),
    );
    expect(res.endpointId).toBe("light_a");
    expect(res.protected).toBe(true);

    const key2 = identityKey({
      entity_id: "light.a",
      registry: reg("U2", "hue"),
    })!;
    expect(id.getIdentity("b", key2)?.endpointId).toBe("light_a");
    // the dormant original record must not have been touched
    expect(id.getIdentity("b", key1)?.lastEntityId).toBe("light.a");
  });

  it("a new entity on a renamed entity's old name gets its own anchor", async () => {
    const id = new FakeIdentityStorage();
    const resolver = new IdentityResolver(
      asIdentity(id),
      asMapping(new FakeMappingStorage()),
    );
    const first = { entity_id: "light.a", registry: reg("U1", "hue") };
    const pass = async (
      entities: { entity_id: string; registry?: HomeAssistantEntityRegistry }[],
    ) =>
      resolver.resolveIdentities(
        "b",
        entities,
        () => undefined,
        true,
        fakeLogger(),
      );
    await pass([first]);
    const renamed = { entity_id: "light.b", registry: reg("U1", "hue") };
    const added = { entity_id: "light.a", registry: reg("U2", "hue") };
    const res = await pass([renamed, added]);
    const anchorB = res.get("light.b")?.anchorEntityId;
    const anchorA = res.get("light.a")?.anchorEntityId;
    expect(anchorB).toBe("light.a");
    expect(anchorA).not.toBe(anchorB);

    const again = await pass([renamed, added]);
    expect(again.get("light.b")?.anchorEntityId).toBe(anchorB);
    expect(again.get("light.a")?.anchorEntityId).toBe(anchorA);
  });
});

// --- bridge manager integration ---

interface FakeHa {
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  entities: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  states: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
  devices: Record<string, any>;
  areas: Map<string, string>;
  labels: unknown[];
  markRefreshIncomplete: () => void;
}

function makeHa(): FakeHa {
  return {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
    markRefreshIncomplete: () => {},
  };
}

function setEntity(
  ha: FakeHa,
  entityId: string,
  reg?: { unique_id?: string; platform?: string },
) {
  ha.entities[entityId] = {
    entity_id: entityId,
    unique_id: reg?.unique_id,
    platform: reg?.platform,
  };
  ha.states[entityId] = {
    entity_id: entityId,
    state: "off",
    attributes: { friendly_name: entityId },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function removeEntity(ha: FakeHa, entityId: string) {
  delete ha.entities[entityId];
  delete ha.states[entityId];
}

// A sensor entity that carries a device_class and an HA device, so the composed
// sensor path (temperature + humidity) can build a real composed device.
function setSensor(
  ha: FakeHa,
  entityId: string,
  deviceClass: string,
  opts?: {
    unique_id?: string;
    platform?: string;
    device_id?: string;
    value?: string;
  },
) {
  ha.entities[entityId] = {
    entity_id: entityId,
    unique_id: opts?.unique_id,
    platform: opts?.platform,
    device_id: opts?.device_id,
  };
  ha.states[entityId] = {
    entity_id: entityId,
    state: opts?.value ?? "21",
    attributes: {
      friendly_name: entityId,
      device_class: deviceClass,
      unit_of_measurement: deviceClass === "temperature" ? "°C" : "%",
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

let dir: string;
let seq = 0;
const servers: ServerNode[] = [];
const managers: BridgeEndpointManager[] = [];

function makeEnv(provider: BridgeDataProvider): Environment {
  const env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, provider);
  env.set(HomeAssistantActions, {
    call(_a: HomeAssistantAction) {},
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => undefined,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  return env;
}

function makeProvider(
  id: string,
  // Pass the same object you keep a handle to, so a live flag flip is visible
  // through the provider getter (BridgeDataProvider shallow-copies the config).
  flags: Record<string, unknown>,
  extra?: {
    uniqueIdSuffix?: string;
    serialNumberSuffix?: string;
    includePattern?: string;
  },
): BridgeDataProvider {
  return new BridgeDataProvider({
    id,
    name: "b",
    port: 0,
    filter: {
      include: [
        {
          type: HomeAssistantMatcherType.Pattern,
          value: extra?.includePattern ?? "switch.*",
        },
      ],
      exclude: [],
      includeMode: "any",
    },
    featureFlags: flags,
    uniqueIdSuffix: extra?.uniqueIdSuffix,
    serialNumberSuffix: extra?.serialNumberSuffix,
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any);
}

async function buildManager(
  ha: FakeHa,
  provider: BridgeDataProvider,
  mapping: FakeMappingStorage,
  identity: FakeIdentityStorage,
): Promise<BridgeEndpointManager> {
  const env = makeEnv(provider);
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `si-node-${seq++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  servers.push(server);
  const registry = new BridgeRegistry(
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    ha as any,
    provider,
  );
  const manager = new BridgeEndpointManager(
    // biome-ignore lint/suspicious/noExplicitAny: client only used for observing
    { connection: {}, haRunning: true, runningSince: 0 } as any,
    registry,
    asMapping(mapping),
    asIdentity(identity),
    provider.id,
    fakeLogger(),
  );
  managers.push(manager);
  await server.add(manager.root);
  return manager;
}

interface Identity {
  number: number;
  id: string;
  uniqueId?: string;
  serialNumber?: string;
  nodeLabel?: string;
  vendorName?: string;
  productName?: string;
}

async function read(
  manager: BridgeEndpointManager,
  entityId: string,
): Promise<Identity | undefined> {
  const ep = [...manager.root.parts].find(
    // biome-ignore lint/suspicious/noExplicitAny: EntityEndpoint carries entityId
    (p) => (p as any).entityId === entityId,
  );
  if (!ep) return undefined;
  await ep.construction.ready;
  const out: Identity = { number: ep.number, id: ep.id };
  await ep.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read runtime state
    const s = (agent as any).bridgedDeviceBasicInformation.state;
    out.uniqueId = s.uniqueId;
    out.serialNumber = s.serialNumber;
    out.nodeLabel = s.nodeLabel;
    out.vendorName = s.vendorName;
    out.productName = s.productName;
  });
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-stable-id-"));
});

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.dispose().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    await s.close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("stable identity through BridgeEndpointManager (#404)", () => {
  it("rename keeps the endpoint number, uniqueId and serialNumber (flag on) (1)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.old", { unique_id: "U", platform: "hue" });
    const identity = new FakeIdentityStorage();
    const manager = await buildManager(
      ha,
      makeProvider("bridge-rename", { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );

    await manager.refreshDevices();
    const before = await read(manager, "switch.old");
    expect(before).toBeDefined();
    expect(before!.number).toBeGreaterThan(0);
    expect(before!.uniqueId).toBe(md5("switch.old"));

    // rename in HA: same unique_id + platform, new entity_id
    removeEntity(ha, "switch.old");
    setEntity(ha, "switch.new", { unique_id: "U", platform: "hue" });
    await manager.refreshDevices();

    const after = await read(manager, "switch.new");
    expect(after).toBeDefined();
    expect(after!.id).toBe(before!.id);
    expect(after!.number).toBe(before!.number);
    expect(after!.uniqueId).toBe(before!.uniqueId);
    expect(after!.serialNumber).toBe(before!.serialNumber);
    // the old entity id is gone
    expect(await read(manager, "switch.old")).toBeUndefined();
  });

  it("re-mints on rename when the entity has no unique_id (2)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.plain");
    const manager = await buildManager(
      ha,
      makeProvider("bridge-plain", { stableIdentity: true }),
      new FakeMappingStorage(),
      new FakeIdentityStorage(),
    );

    await manager.refreshDevices();
    const before = await read(manager, "switch.plain");
    expect(before).toBeDefined();

    removeEntity(ha, "switch.plain");
    setEntity(ha, "switch.plain2");
    await manager.refreshDevices();

    const after = await read(manager, "switch.plain2");
    expect(after).toBeDefined();
    expect(after!.id).not.toBe(before!.id);
    expect(after!.number).not.toBe(before!.number);
    expect(after!.uniqueId).not.toBe(before!.uniqueId);
  });

  it("grandfathering: identity is unchanged after flipping the flag on (3)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.gf", { unique_id: "U", platform: "hue" });
    const identity = new FakeIdentityStorage();
    // hold the flags object so we can flip it live on the same bridge
    const flags: Record<string, unknown> = { stableIdentity: false };
    const provider = makeProvider("bridge-gf", flags);

    const manager = await buildManager(
      ha,
      provider,
      new FakeMappingStorage(),
      identity,
    );
    await manager.refreshDevices();
    const before = await read(manager, "switch.gf");
    expect(before).toBeDefined();

    // flip the flag on for the same bridge, then rebuild
    flags.stableIdentity = true;
    await manager.refreshDevices();

    const after = await read(manager, "switch.gf");
    expect(after).toBeDefined();
    expect(after!.id).toBe(before!.id);
    expect(after!.number).toBe(before!.number);
    expect(after!.uniqueId).toBe(before!.uniqueId);
  });

  it("customName change keeps a protected number, re-mints an unprotected one, nodeLabel follows (7)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.prot", { unique_id: "U", platform: "hue" });
    setEntity(ha, "switch.plain");
    const mapping = new FakeMappingStorage();
    const manager = await buildManager(
      ha,
      makeProvider("bridge-name", { stableIdentity: true }),
      mapping,
      new FakeIdentityStorage(),
    );

    await manager.refreshDevices();
    const protBefore = await read(manager, "switch.prot");
    const plainBefore = await read(manager, "switch.plain");

    mapping.put("bridge-name", {
      entityId: "switch.prot",
      customName: "Kitchen",
    });
    mapping.put("bridge-name", {
      entityId: "switch.plain",
      customName: "Living",
    });
    await manager.refreshDevices();

    const protAfter = await read(manager, "switch.prot");
    expect(protAfter!.id).toBe(protBefore!.id);
    expect(protAfter!.number).toBe(protBefore!.number);
    expect(protAfter!.uniqueId).toBe(protBefore!.uniqueId);
    expect(protAfter!.nodeLabel).toBe("Kitchen");

    const plainAfter = await read(manager, "switch.plain");
    expect(plainAfter!.number).not.toBe(plainBefore!.number);
    expect(plainAfter!.nodeLabel).toBe("Living");
  });

  it("suffixes still drive uniqueId and serialNumber, endpoint id stays put (5)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.s", { unique_id: "U", platform: "hue" });

    const a = await buildManager(
      ha,
      makeProvider(
        "bridge-suffix-a",
        { stableIdentity: true },
        { uniqueIdSuffix: "AAA" },
      ),
      new FakeMappingStorage(),
      new FakeIdentityStorage(),
    );
    await a.refreshDevices();
    const first = await read(a, "switch.s");

    const b = await buildManager(
      ha,
      makeProvider(
        "bridge-suffix-b",
        { stableIdentity: true },
        {
          uniqueIdSuffix: "BBB",
          serialNumberSuffix: "ZZ",
        },
      ),
      new FakeMappingStorage(),
      new FakeIdentityStorage(),
    );
    await b.refreshDevices();
    const second = await read(b, "switch.s");

    expect(first!.uniqueId).toBe(md5("switch.sAAA"));
    expect(second!.uniqueId).toBe(md5("switch.sBBB"));
    expect(second!.serialNumber?.endsWith("ZZ")).toBe(true);
    // endpoint id is independent of both suffixes
    expect(first!.id).toBe("switch_s");
    expect(second!.id).toBe("switch_s");
  });

  it("stamps missingSince when the entity leaves the full registry, clears on return, never auto-deletes (orphan cleanup)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.orphan", { unique_id: "U", platform: "hue" });
    // A second entity keeps the registry non-empty: a fully empty snapshot
    // reads as HA down and must not stamp anything (#438).
    setEntity(ha, "switch.other", { unique_id: "UO", platform: "hue" });
    const identity = new FakeIdentityStorage();
    const manager = await buildManager(
      ha,
      makeProvider("bridge-orphan", { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );
    const key = identityKey({
      entity_id: "switch.orphan",
      registry: reg("U", "hue"),
    })!;

    await manager.refreshDevices();
    // present: record seeded, no tombstone
    expect(identity.getIdentity("bridge-orphan", key)).toBeDefined();
    expect(
      identity.getIdentity("bridge-orphan", key)?.missingSince,
    ).toBeUndefined();

    // removed from HA entirely
    removeEntity(ha, "switch.orphan");
    await manager.refreshDevices();
    // record survives (not auto-deleted) and is tombstoned
    const stamped = identity.getIdentity("bridge-orphan", key);
    expect(stamped).toBeDefined();
    expect(typeof stamped?.missingSince).toBe("string");

    // reappears under the same unique_id: tombstone cleared
    setEntity(ha, "switch.orphan", { unique_id: "U", platform: "hue" });
    await manager.refreshDevices();
    expect(identity.getIdentity("bridge-orphan", key)).toBeDefined();
    expect(
      identity.getIdentity("bridge-orphan", key)?.missingSince,
    ).toBeUndefined();
  });

  it("does not stamp or renumber anything from an empty registry snapshot (#438)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.orphan", { unique_id: "U", platform: "hue" });
    const identity = new FakeIdentityStorage();
    const manager = await buildManager(
      ha,
      makeProvider("bridge-438-stamp", { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );
    const key = identityKey({
      entity_id: "switch.orphan",
      registry: reg("U", "hue"),
    })!;
    await manager.refreshDevices();
    const before = await read(manager, "switch.orphan");

    // HA down: the whole registry empties. No tombstone, no removal.
    ha.entities = {};
    ha.states = {};
    await manager.refreshDevices();
    expect(
      identity.getIdentity("bridge-438-stamp", key)?.missingSince,
    ).toBeUndefined();

    // HA back with the same entity: same endpoint number, still no stamp.
    setEntity(ha, "switch.orphan", { unique_id: "U", platform: "hue" });
    await manager.refreshDevices();
    const after = await read(manager, "switch.orphan");
    expect(after!.number).toBe(before!.number);
    expect(
      identity.getIdentity("bridge-438-stamp", key)?.missingSince,
    ).toBeUndefined();
  });

  it("does not tombstone a present entity that the bridge filter excludes (full registry, not filtered)", async () => {
    const ha = makeHa();
    // in the bridge (matches switch.*)
    setEntity(ha, "switch.keep", { unique_id: "UK", platform: "hue" });
    // present in HA but outside this bridge's switch.* filter
    setEntity(ha, "sensor.excluded", { unique_id: "UX", platform: "hue" });
    const identity = new FakeIdentityStorage();
    // a record already exists for the excluded entity (seeded while it was in
    // scope, before a filter narrowing). It must not be tombstoned while the
    // entity is still present in the FULL registry.
    const excludedKey = identityKey({
      entity_id: "sensor.excluded",
      registry: reg("UX", "hue"),
    })!;
    identity.setIdentity("bridge-filtered", excludedKey, {
      endpointId: "sensor_excluded",
      anchorEntityId: "sensor.excluded",
      lastEntityId: "sensor.excluded",
    });

    const manager = await buildManager(
      ha,
      makeProvider("bridge-filtered", { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );
    await manager.refreshDevices();

    // switch.keep is in the bridge and got its record seeded...
    const keepKey = identityKey({
      entity_id: "switch.keep",
      registry: reg("UK", "hue"),
    })!;
    expect(identity.getIdentity("bridge-filtered", keepKey)).toBeDefined();
    // ...and the excluded-but-present entity was NOT tombstoned, because
    // stamping reads the full registry, not the bridge's filtered set. Were it
    // to read the filtered set, sensor.excluded would be absent and stamped.
    expect(
      identity.getIdentity("bridge-filtered", excludedKey)?.missingSince,
    ).toBeUndefined();
  });

  // X was switch.a and is renamed to switch.b, a new entity Y takes switch.a.
  function seedRenamed(identity: FakeIdentityStorage, bridgeId: string) {
    const xKey = identityKey({
      entity_id: "switch.b",
      registry: reg("UX", "hue"),
    })!;
    identity.setIdentity(bridgeId, xKey, {
      endpointId: "switch_a",
      anchorEntityId: "switch.a",
      lastEntityId: "switch.a",
    });
  }

  for (const yFirst of [true, false]) {
    it(`a renamed entity keeps its frozen id when a new entity takes its old name (${yFirst ? "new first" : "renamed first"})`, async () => {
      const ha = makeHa();
      const order = yFirst
        ? ["switch.a", "switch.b"]
        : ["switch.b", "switch.a"];
      for (const e of order) {
        setEntity(ha, e, { unique_id: e === "switch.a" ? "UY" : "UX" });
        ha.entities[e].platform = "hue";
      }
      const identity = new FakeIdentityStorage();
      const bridgeId = `bridge-dup-${yFirst}`;
      seedRenamed(identity, bridgeId);
      const manager = await buildManager(
        ha,
        makeProvider(bridgeId, { stableIdentity: true }),
        new FakeMappingStorage(),
        identity,
      );

      await manager.refreshDevices();
      expect((await read(manager, "switch.b"))?.id).toBe("switch_a");
      expect((await read(manager, "switch.a"))?.id).toBe("switch_a_2");
    });

    it(`a renamed entity keeps its frozen id when a keyless entity takes its old name (${yFirst ? "new first" : "renamed first"})`, async () => {
      const ha = makeHa();
      const order = yFirst
        ? ["switch.a", "switch.b"]
        : ["switch.b", "switch.a"];
      for (const e of order) {
        if (e === "switch.a") setEntity(ha, e);
        else setEntity(ha, e, { unique_id: "UX", platform: "hue" });
      }
      const identity = new FakeIdentityStorage();
      const bridgeId = `bridge-dup-keyless-${yFirst}`;
      seedRenamed(identity, bridgeId);
      const manager = await buildManager(
        ha,
        makeProvider(bridgeId, { stableIdentity: true }),
        new FakeMappingStorage(),
        identity,
      );

      await manager.refreshDevices();
      expect((await read(manager, "switch.b"))?.id).toBe("switch_a");
      expect((await read(manager, "switch.a"))?.id).toBe("switch_a_2");
      // the keyless entity has no key, so nothing is stored for it
      expect(identity.getBridgeIdentities(bridgeId).size).toBe(1);
    });

    it(`a mounted entity renamed while another takes its old name keeps its number (${yFirst ? "new first" : "renamed first"})`, async () => {
      for (const y of ["keyed", "keyless", "next refresh"]) {
        const ha = makeHa();
        setEntity(ha, "switch.a", { unique_id: "UX", platform: "hue" });
        const identity = new FakeIdentityStorage();
        const mapping = new FakeMappingStorage();
        const bridgeId = `bridge-mounted-${y}-${yFirst}`;
        const manager = await buildManager(
          ha,
          makeProvider(bridgeId, { stableIdentity: true }),
          mapping,
          identity,
        );
        await manager.refreshDevices();
        const before = await read(manager, "switch.a");

        removeEntity(ha, "switch.a");
        if (y === "next refresh") {
          setEntity(ha, "switch.b", { unique_id: "UX", platform: "hue" });
          await manager.refreshDevices();
          removeEntity(ha, "switch.b");
        }
        for (const e of yFirst
          ? ["switch.a", "switch.b"]
          : ["switch.b", "switch.a"]) {
          if (e === "switch.b") {
            setEntity(ha, e, { unique_id: "UX", platform: "hue" });
          } else if (y === "keyless") {
            setEntity(ha, e);
          } else {
            setEntity(ha, e, { unique_id: "UY", platform: "hue" });
          }
        }
        await manager.refreshDevices();

        expect(manager.failedEntities).toEqual([]);
        expect(await read(manager, "switch.b"), y).toMatchObject({
          id: "switch_a",
          number: before?.number,
        });
        const taken = await read(manager, "switch.a");
        expect(taken?.id).toBe("switch_a_2");
        expect(taken?.number).not.toBe(before?.number);

        // a restart with the same registry mounts the same ids
        const restarted = await buildManager(
          ha,
          makeProvider(bridgeId, { stableIdentity: true }),
          mapping,
          identity,
        );
        await restarted.refreshDevices();
        expect((await read(restarted, "switch.b"))?.id).toBe("switch_a");
        expect((await read(restarted, "switch.a"))?.id).toBe("switch_a_2");
      }
    });
  }

  it("flag off: a renamed entity and a new entity on its old name keep the live derivation", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.a", { unique_id: "UY", platform: "hue" });
    setEntity(ha, "switch.b", { unique_id: "UX", platform: "hue" });
    const identity = new FakeIdentityStorage();
    seedRenamed(identity, "bridge-dup-off");
    const manager = await buildManager(
      ha,
      makeProvider("bridge-dup-off", { stableIdentity: false }),
      new FakeMappingStorage(),
      identity,
    );

    await manager.refreshDevices();
    expect((await read(manager, "switch.a"))?.id).toBe("switch_a");
    expect((await read(manager, "switch.b"))?.id).toBe("switch_b");
  });

  it("a second entity on a taken endpoint id is a failed entity naming the holder", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.one");
    setEntity(ha, "switch.two");
    const mapping = new FakeMappingStorage();
    for (const entityId of ["switch.one", "switch.two"]) {
      mapping.put("bridge-dup-name", { entityId, customName: "Lamp" });
    }
    const manager = await buildManager(
      ha,
      makeProvider("bridge-dup-name", { stableIdentity: false }),
      mapping,
      new FakeIdentityStorage(),
    );

    await expect(manager.refreshDevices()).resolves.toBe(true);
    expect((await read(manager, "switch.one"))?.id).toBe("Lamp");
    expect(await read(manager, "switch.two")).toBeUndefined();
    expect(manager.failedEntities).toEqual([
      expect.objectContaining({
        entityId: "switch.two",
        reason:
          "Endpoint id collides with switch.one. Set distinct custom names.",
      }),
    ]);

    // the next pass keeps the mounted one and reports the same
    await manager.refreshDevices();
    expect((await read(manager, "switch.one"))?.id).toBe("Lamp");
    expect(manager.failedEntities.map((f) => f.entityId)).toEqual([
      "switch.two",
    ]);
  });

  it("two stored records on the same endpoint id: the first keeps it, the later one moves and is rewritten", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.one", { unique_id: "U1", platform: "hue" });
    setEntity(ha, "switch.two", { unique_id: "U2", platform: "hue" });
    const identity = new FakeIdentityStorage();
    const bridgeId = "bridge-dup-heal";
    const key = (entity_id: string, u: string) =>
      identityKey({ entity_id, registry: reg(u, "hue") })!;
    for (const [e, u] of [
      ["switch.one", "U1"],
      ["switch.two", "U2"],
    ]) {
      identity.setIdentity(bridgeId, key(e, u), {
        endpointId: "switch_dup",
        anchorEntityId: e,
        lastEntityId: e,
      });
    }
    const manager = await buildManager(
      ha,
      makeProvider(bridgeId, { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );

    await manager.refreshDevices();
    expect((await read(manager, "switch.one"))?.id).toBe("switch_dup");
    expect((await read(manager, "switch.two"))?.id).toBe("switch_dup_2");
    expect(
      identity.getIdentity(bridgeId, key("switch.two", "U2"))?.endpointId,
    ).toBe("switch_dup_2");
    expect(
      identity.getIdentity(bridgeId, key("switch.one", "U1"))?.endpointId,
    ).toBe("switch_dup");
    // biome-ignore lint/suspicious/noExplicitAny: read the injected logger
    const warn = (manager as any).log.warn as ReturnType<typeof vi.fn>;
    const named = warn.mock.calls.filter((c) => {
      const msg = String(c[0]);
      return msg.includes("switch.one") && msg.includes("switch.two");
    });
    expect(named).toHaveLength(1);

    // healed: the next refresh keeps both ids and warns no more
    warn.mockClear();
    await manager.refreshDevices();
    expect((await read(manager, "switch.two"))?.id).toBe("switch_dup_2");
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes("shares endpoint id"),
      ),
    ).toHaveLength(0);
  });

  it.each([
    true,
    false,
  ])("two mounted entities swapping entity_ids keep their numbers without a mapping recreate (stableIdentity %s) (#543)", async (stableIdentity) => {
    const ha = makeHa();
    setEntity(ha, "switch.a", { unique_id: "UA", platform: "hue" });
    setEntity(ha, "switch.b", { unique_id: "UB", platform: "hue" });
    const mapping = new FakeMappingStorage();
    const bridgeId = `bridge-swap-mapped-${stableIdentity}`;
    mapping.put(bridgeId, { entityId: "switch.a", customName: "Lamp A" });
    mapping.put(bridgeId, { entityId: "switch.b", customName: "Lamp B" });
    const manager = await buildManager(
      ha,
      makeProvider(bridgeId, { stableIdentity }),
      mapping,
      new FakeIdentityStorage(),
    );
    await manager.refreshDevices();
    const a = await read(manager, "switch.a");
    const b = await read(manager, "switch.b");

    setEntity(ha, "switch.a", { unique_id: "UB", platform: "hue" });
    setEntity(ha, "switch.b", { unique_id: "UA", platform: "hue" });
    // biome-ignore lint/suspicious/noExplicitAny: read the injected logger
    const info = (manager as any).log.info as ReturnType<typeof vi.fn>;
    info.mockClear();
    await manager.refreshDevices();

    expect(manager.failedEntities).toEqual([]);
    // with the flag on the identity carries the number, off the entity_id does
    const [onA, onB] = stableIdentity ? [b, a] : [a, b];
    expect(await read(manager, "switch.a")).toMatchObject({
      id: onA?.id,
      number: onA?.number,
    });
    expect(await read(manager, "switch.b")).toMatchObject({
      id: onB?.id,
      number: onB?.number,
    });
    expect(
      info.mock.calls.filter((c) => String(c[0]).includes("Mapping changed")),
    ).toEqual([]);
  });

  it("two stored records on the same endpoint id: the mounted one keeps it even when the other comes first (#543)", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.two", { unique_id: "U2", platform: "hue" });
    const identity = new FakeIdentityStorage();
    const bridgeId = "bridge-dup-mounted";
    const key = (entity_id: string, u: string) =>
      identityKey({ entity_id, registry: reg(u, "hue") })!;
    const dup = (e: string) => ({
      endpointId: "switch_dup",
      anchorEntityId: e,
      lastEntityId: e,
    });
    identity.setIdentity(bridgeId, key("switch.two", "U2"), dup("switch.two"));
    const manager = await buildManager(
      ha,
      makeProvider(bridgeId, { stableIdentity: true }),
      new FakeMappingStorage(),
      identity,
    );
    await manager.refreshDevices();
    const before = await read(manager, "switch.two");
    expect(before?.id).toBe("switch_dup");

    // switch.one appears ahead of switch.two with a record on the same id
    const { entities } = ha;
    ha.entities = {};
    setEntity(ha, "switch.one", { unique_id: "U1", platform: "hue" });
    Object.assign(ha.entities, entities);
    identity.setIdentity(bridgeId, key("switch.one", "U1"), dup("switch.one"));
    await manager.refreshDevices();

    expect(Object.keys(ha.entities)).toEqual(["switch.one", "switch.two"]);
    expect(await read(manager, "switch.two")).toMatchObject({
      id: "switch_dup",
      number: before?.number,
    });
    expect((await read(manager, "switch.one"))?.id).toBe("switch_dup_2");
    expect(
      identity.getIdentity(bridgeId, key("switch.two", "U2"))?.endpointId,
    ).toBe("switch_dup");
    expect(
      identity.getIdentity(bridgeId, key("switch.one", "U1"))?.endpointId,
    ).toBe("switch_dup_2");
    expect(manager.failedEntities).toEqual([]);
  });
});

describe("composed device stable identity through BridgeEndpointManager (#404)", () => {
  it("composed sensor rename keeps the parent uniqueId, serialNumber and number (flag on)", async () => {
    const ha = makeHa();
    setSensor(ha, "sensor.old_temperature", "temperature", {
      unique_id: "TU",
      platform: "hue",
      device_id: "dev1",
    });
    setSensor(ha, "sensor.hum", "humidity", { device_id: "dev1" });
    ha.devices.dev1 = { id: "dev1", name: "Hub" };

    const mapping = new FakeMappingStorage();
    mapping.put("bridge-composed", {
      entityId: "sensor.old_temperature",
      humidityEntity: "sensor.hum",
    });

    const manager = await buildManager(
      ha,
      makeProvider(
        "bridge-composed",
        { stableIdentity: true, autoComposedDevices: true },
        { includePattern: "*_temperature" },
      ),
      mapping,
      new FakeIdentityStorage(),
    );

    await manager.refreshDevices();
    const before = await read(manager, "sensor.old_temperature");
    expect(before).toBeDefined();
    expect(before!.number).toBeGreaterThan(0);
    // really composed: temperature sub + humidity sub under the parent
    const parent = [...manager.root.parts].find(
      // biome-ignore lint/suspicious/noExplicitAny: EntityEndpoint carries entityId
      (p) => (p as any).entityId === "sensor.old_temperature",
    );
    expect([...parent!.parts].length).toBe(2);

    // rename the primary in HA: same unique_id + platform, new entity_id
    removeEntity(ha, "sensor.old_temperature");
    setSensor(ha, "sensor.new_temperature", "temperature", {
      unique_id: "TU",
      platform: "hue",
      device_id: "dev1",
    });
    await manager.refreshDevices();

    const after = await read(manager, "sensor.new_temperature");
    expect(after).toBeDefined();
    expect(after!.id).toBe(before!.id);
    expect(after!.number).toBe(before!.number);
    // the parent identity is anchored on the primary, so it survives the rename
    expect(after!.uniqueId).toBe(before!.uniqueId);
    expect(after!.serialNumber).toBe(before!.serialNumber);
    expect(await read(manager, "sensor.old_temperature")).toBeUndefined();
  });
});

// --- identity lifecycle through the matter API (#404) ---

describe("identity lifecycle through the matter API (#404)", () => {
  async function withRouter(
    // biome-ignore lint/suspicious/noExplicitAny: minimal bridge service stub
    bridgeService: any,
    identity: FakeIdentityStorage,
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const app = express();
    app.use(
      "/matter",
      // biome-ignore lint/suspicious/noExplicitAny: stub stands in for the service
      matterApi(bridgeService as any, undefined, asIdentity(identity)),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("factory reset clears identity records before the bridge rebuilds them (finding 2a)", async () => {
    const identity = new FakeIdentityStorage();
    const bridgeId = "bridge-fr";
    const key = identityKey({
      entity_id: "switch.x",
      registry: reg("U", "hue"),
    })!;
    identity.setIdentity(bridgeId, key, {
      endpointId: "switch_x",
      anchorEntityId: "switch.x",
      lastEntityId: "switch.x",
    });

    // factoryReset() restarts and refreshes the bridge internally; that rebuild
    // is where the resolver would consume stale records, so it must see none.
    let recordsSeenDuringRebuild = -1;
    const bridge = {
      id: bridgeId,
      // the route refuses a reset unless the bridge runs
      data: { id: bridgeId, status: BridgeStatus.Running },
      async factoryReset(beforeReset?: () => Promise<void>) {
        await beforeReset?.();
        recordsSeenDuringRebuild = identity.getBridgeIdentities(bridgeId).size;
        return true;
      },
      async start() {},
    };
    const bridgeService = { bridges: [bridge] };

    await withRouter(bridgeService, identity, async (baseUrl) => {
      const res = await fetch(
        `${baseUrl}/matter/bridges/${bridgeId}/actions/factory-reset`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
    });

    expect(recordsSeenDuringRebuild).toBe(0);
    expect(identity.getBridgeIdentities(bridgeId).size).toBe(0);
  });

  it("deleting a bridge clears its identity records (finding 2b)", async () => {
    const identity = new FakeIdentityStorage();
    const bridgeId = "bridge-del";
    const key = identityKey({
      entity_id: "switch.x",
      registry: reg("U", "hue"),
    })!;
    identity.setIdentity(bridgeId, key, {
      endpointId: "switch_x",
      anchorEntityId: "switch.x",
      lastEntityId: "switch.x",
    });
    expect(identity.getBridgeIdentities(bridgeId).size).toBe(1);

    const bridgeService = {
      bridges: [{ id: bridgeId }],
      async delete() {},
    };

    await withRouter(bridgeService, identity, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/matter/bridges/${bridgeId}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
    });

    expect(identity.getBridgeIdentities(bridgeId).size).toBe(0);
  });

  it("orphan routes 404 on an unknown bridge, mirroring factory-reset (API consistency)", async () => {
    const identity = new FakeIdentityStorage();
    const bridgeService = { bridges: [{ id: "bridge-known" }] };

    await withRouter(bridgeService, identity, async (baseUrl) => {
      const get = await fetch(
        `${baseUrl}/matter/bridges/bridge-unknown/orphans`,
      );
      expect(get.status).toBe(404);

      const post = await fetch(
        `${baseUrl}/matter/bridges/bridge-unknown/actions/cleanup-orphans`,
        { method: "POST" },
      );
      expect(post.status).toBe(404);
    });
  });
});

// #467: an endpoint that survives a refresh kept the Home Assistant registry
// snapshot it was built with, so a device renamed in HA (and its manufacturer,
// model or firmware version) only reached the Matter attributes after a
// restart. The device name reaches nodeLabel through friendly_name, which the
// state path already carried; these cover the registry-derived attributes and
// the preferEntityRegistryName name source.
describe("registry snapshot follows Home Assistant (#467)", () => {
  function attachDevice(
    ha: FakeHa,
    entityId: string,
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    device: Record<string, any>,
  ) {
    ha.entities[entityId].device_id = device.id;
    ha.devices[device.id] = device;
  }

  it("a renamed device updates vendorName and productName without moving the endpoint", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.oven", { unique_id: "U", platform: "hue" });
    attachDevice(ha, "switch.oven", {
      id: "d1",
      name: "Old Oven",
      manufacturer: "OldMfr",
      model: "OldModel",
    });
    const manager = await buildManager(
      ha,
      makeProvider("bridge-467-device", {}),
      new FakeMappingStorage(),
      new FakeIdentityStorage(),
    );

    await manager.refreshDevices();
    const before = await read(manager, "switch.oven");
    expect(before).toBeDefined();
    expect(before!.vendorName).toBe("OldMfr");
    expect(before!.productName).toBe("OldModel");

    // HA replaces the registry objects on every reload, it does not mutate them
    ha.devices.d1 = {
      id: "d1",
      name: "New Oven",
      manufacturer: "NewMfr",
      model: "NewModel",
    };
    await manager.refreshDevices();

    const after = await read(manager, "switch.oven");
    expect(after).toBeDefined();
    expect(after!.vendorName).toBe("NewMfr");
    expect(after!.productName).toBe("NewModel");
    // the accessory must not look like a new device to a controller
    expect(after!.number).toBe(before!.number);
    expect(after!.id).toBe(before!.id);
    expect(after!.uniqueId).toBe(before!.uniqueId);
    expect(after!.serialNumber).toBe(before!.serialNumber);
  });

  it("a renamed entity reaches nodeLabel with preferEntityRegistryName", async () => {
    const ha = makeHa();
    setEntity(ha, "switch.lamp", { unique_id: "U", platform: "hue" });
    ha.entities["switch.lamp"].name = "Registry Old";
    const manager = await buildManager(
      ha,
      makeProvider("bridge-467-entity", { preferEntityRegistryName: true }),
      new FakeMappingStorage(),
      new FakeIdentityStorage(),
    );

    await manager.refreshDevices();
    const before = await read(manager, "switch.lamp");
    expect(before!.nodeLabel).toBe("Registry Old");

    ha.entities["switch.lamp"] = {
      entity_id: "switch.lamp",
      unique_id: "U",
      platform: "hue",
      name: "Registry New",
    };
    await manager.refreshDevices();

    const after = await read(manager, "switch.lamp");
    expect(after!.nodeLabel).toBe("Registry New");
    expect(after!.number).toBe(before!.number);
    expect(after!.id).toBe(before!.id);
  });
});
