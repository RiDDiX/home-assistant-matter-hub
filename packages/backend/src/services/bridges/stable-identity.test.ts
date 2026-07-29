import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
}

function makeHa(): FakeHa {
  return {
    entities: {},
    states: {},
    devices: {},
    areas: new Map(),
    labels: [],
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
    { connection: {} } as any,
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
      data: { id: bridgeId },
      async factoryReset() {
        recordsSeenDuringRebuild = identity.getBridgeIdentities(bridgeId).size;
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
