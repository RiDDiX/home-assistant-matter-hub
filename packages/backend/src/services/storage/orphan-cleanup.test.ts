import type { HomeAssistantEntityRegistry } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { identityKey } from "../bridges/identity-resolver.js";
import type { IdentityRecord } from "./entity-identity-storage.js";
import {
  buildPresentIdentityKeys,
  computeOrphanCandidates,
  executeOrphanCleanup,
  ORPHAN_TOMBSTONE_MS,
  stampIdentityPresence,
  stampMappingPresence,
} from "./orphan-cleanup.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-20T00:00:00.000Z");

function entity(
  entity_id: string,
  unique_id?: string,
  platform?: string,
): HomeAssistantEntityRegistry {
  return { entity_id, unique_id, platform } as HomeAssistantEntityRegistry;
}

function keyOf(entity_id: string, unique_id: string, platform: string): string {
  return identityKey({
    entity_id,
    registry: entity(entity_id, unique_id, platform),
  })!;
}

// Minimal in-memory identity store mirroring EntityIdentityStorage's stamp/clear
// contract, so stampIdentityPresence can be driven without the real storage.
class FakeIdentityStore {
  m = new Map<string, Map<string, IdentityRecord>>();
  set(bridgeId: string, key: string, record: IdentityRecord) {
    let bridgeMap = this.m.get(bridgeId);
    if (!bridgeMap) {
      bridgeMap = new Map();
      this.m.set(bridgeId, bridgeMap);
    }
    bridgeMap.set(key, record);
  }
  get(bridgeId: string, key: string) {
    return this.m.get(bridgeId)?.get(key);
  }
  getBridgeIdentities(bridgeId: string): ReadonlyMap<string, IdentityRecord> {
    return this.m.get(bridgeId) ?? new Map<string, IdentityRecord>();
  }
  markIdentityMissing(bridgeId: string, key: string, nowIso: string) {
    const record = this.m.get(bridgeId)?.get(key);
    if (!record || record.missingSince != null) return;
    record.missingSince = nowIso;
  }
  clearIdentityMissing(bridgeId: string, key: string) {
    const record = this.m.get(bridgeId)?.get(key);
    if (!record || record.missingSince == null) return;
    delete record.missingSince;
  }
  async deleteIdentity(bridgeId: string, key: string) {
    this.m.get(bridgeId)?.delete(key);
  }
}

class FakeMappingStore {
  m = new Map<
    string,
    Map<string, { entityId: string; missingSince?: string }>
  >();
  put(bridgeId: string, entityId: string, missingSince?: string) {
    let bridgeMap = this.m.get(bridgeId);
    if (!bridgeMap) {
      bridgeMap = new Map();
      this.m.set(bridgeId, bridgeMap);
    }
    bridgeMap.set(entityId, { entityId, missingSince });
  }
  getMapping(bridgeId: string, entityId: string) {
    return this.m.get(bridgeId)?.get(entityId);
  }
  getMappingsForBridge(bridgeId: string) {
    return [...(this.m.get(bridgeId)?.values() ?? [])];
  }
  markMappingMissing(bridgeId: string, entityId: string, nowIso: string) {
    const record = this.m.get(bridgeId)?.get(entityId);
    if (!record || record.missingSince != null) return;
    record.missingSince = nowIso;
  }
  clearMappingMissing(bridgeId: string, entityId: string) {
    const record = this.m.get(bridgeId)?.get(entityId);
    if (!record || record.missingSince == null) return;
    delete record.missingSince;
  }
  async deleteMapping(bridgeId: string, entityId: string) {
    this.m.get(bridgeId)?.delete(entityId);
  }
}

describe("buildPresentIdentityKeys", () => {
  it("keys every unique_id entity in the full registry, skips keyless ones", () => {
    const keys = buildPresentIdentityKeys({
      "light.a": entity("light.a", "UA", "hue"),
      "light.b": entity("light.b"),
    });
    expect(keys.has(keyOf("light.a", "UA", "hue"))).toBe(true);
    expect(keys.size).toBe(1);
  });
});

describe("stampIdentityPresence", () => {
  it("does not stamp an entity that is present in the full registry (filter-narrowed)", () => {
    const store = new FakeIdentityStore();
    const key = keyOf("sensor.temp", "U", "hue");
    // present in HA but outside this bridge's filter: still a live key
    store.set("b", key, { endpointId: "e", anchorEntityId: "sensor.temp" });

    stampIdentityPresence(store, "b", new Set([key]), NOW);

    expect(store.get("b", key)?.missingSince).toBeUndefined();
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set([key]),
      presentEntityIds: new Set(),
      hasMapping: () => false,
      now: NOW + 30 * DAY,
    });
    expect(candidates).toEqual([]);
  });

  it("stamps once on absence and clears on return", () => {
    const store = new FakeIdentityStore();
    const key = keyOf("light.x", "U", "hue");
    store.set("b", key, { endpointId: "e", anchorEntityId: "light.x" });

    stampIdentityPresence(store, "b", new Set(), NOW);
    expect(store.get("b", key)?.missingSince).toBe(new Date(NOW).toISOString());

    // a later absent pass keeps the first-seen time
    stampIdentityPresence(store, "b", new Set(), NOW + DAY);
    expect(store.get("b", key)?.missingSince).toBe(new Date(NOW).toISOString());

    // entity returns: tombstone cleared, drops out of candidates
    stampIdentityPresence(store, "b", new Set([key]), NOW + 2 * DAY);
    expect(store.get("b", key)?.missingSince).toBeUndefined();
  });
});

describe("computeOrphanCandidates", () => {
  it("does not offer a record younger than the tombstone window", () => {
    const key = keyOf("light.x", "U", "hue");
    const identities = new Map<string, IdentityRecord>([
      [
        key,
        {
          endpointId: "e",
          anchorEntityId: "light.x",
          lastEntityId: "light.x",
          missingSince: new Date(NOW - 6 * DAY).toISOString(),
        },
      ],
    ]);
    expect(
      computeOrphanCandidates({
        bridgeId: "b",
        identities,
        presentKeys: new Set(),
        presentEntityIds: new Set(),
        hasMapping: () => false,
        now: NOW,
      }),
    ).toEqual([]);

    // age it past the window and it becomes a candidate
    identities.get(key)!.missingSince = new Date(NOW - 8 * DAY).toISOString();
    const aged = computeOrphanCandidates({
      bridgeId: "b",
      identities,
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: () => false,
      now: NOW,
    });
    expect(aged).toHaveLength(1);
    expect(aged[0].identityKey).toBe(key);
    expect(aged[0].lastEntityId).toBe("light.x");
    expect(ORPHAN_TOMBSTONE_MS).toBe(7 * DAY);
  });

  it("reports hasMapping from the last-seen entity id", () => {
    const key = keyOf("light.new", "U", "hue");
    const identities = new Map<string, IdentityRecord>([
      [
        key,
        {
          endpointId: "e",
          anchorEntityId: "light.old",
          lastEntityId: "light.new",
          missingSince: new Date(NOW - 8 * DAY).toISOString(),
        },
      ],
    ]);
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities,
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: (e) => e === "light.new",
      now: NOW,
    });
    expect(candidates[0].hasMapping).toBe(true);
  });
});

describe("executeOrphanCleanup", () => {
  function aged(anchor: string, last = anchor): IdentityRecord {
    return {
      endpointId: "e",
      anchorEntityId: anchor,
      lastEntityId: last,
      missingSince: new Date(NOW - 8 * DAY).toISOString(),
    };
  }

  it("deletes exactly the requested keys and their linked mapping, leaves the rest", async () => {
    const store = new FakeIdentityStore();
    const mappings = new FakeMappingStore();
    const k1 = keyOf("light.1", "U1", "hue");
    const k2 = keyOf("light.2", "U2", "hue");
    const k3 = keyOf("light.3", "U3", "hue");
    store.set("b", k1, aged("light.1"));
    store.set("b", k2, aged("light.2"));
    store.set("b", k3, aged("light.3"));
    mappings.put("b", "light.1");
    mappings.put("b", "light.3");

    const results = await executeOrphanCleanup({
      bridgeId: "b",
      requestedKeys: [k1, k2],
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      getMapping: (b, e) => mappings.getMapping(b, e),
      deleteMapping: (b, e) => mappings.deleteMapping(b, e),
      deleteIdentity: (b, k) => store.deleteIdentity(b, k),
      now: NOW,
    });

    expect(results).toEqual([
      { identityKey: k1, deleted: true },
      { identityKey: k2, deleted: true },
    ]);
    expect(store.get("b", k1)).toBeUndefined();
    expect(store.get("b", k2)).toBeUndefined();
    expect(store.get("b", k3)).toBeDefined();
    // k1's mapping is gone with its identity, k3 (unrequested) is untouched
    expect(mappings.getMapping("b", "light.1")).toBeUndefined();
    expect(mappings.getMapping("b", "light.3")).toBeDefined();
  });

  it("skips a key whose entity returned between the dry-run and the POST", async () => {
    const store = new FakeIdentityStore();
    const mappings = new FakeMappingStore();
    const key = keyOf("light.back", "U", "hue");
    store.set("b", key, aged("light.back"));

    // entity reappeared: its key is present again at execution time
    const results = await executeOrphanCleanup({
      bridgeId: "b",
      requestedKeys: [key],
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set([key]),
      presentEntityIds: new Set(),
      getMapping: (b, e) => mappings.getMapping(b, e),
      deleteMapping: (b, e) => mappings.deleteMapping(b, e),
      deleteIdentity: (b, k) => store.deleteIdentity(b, k),
      now: NOW,
    });

    expect(results[0].deleted).toBe(false);
    expect(results[0].reason).toBeDefined();
    expect(store.get("b", key)).toBeDefined();
  });

  it("keeps a live entity's mapping when a removed entity's tombstone reused its id", async () => {
    const store = new FakeIdentityStore();
    const mappings = new FakeMappingStore();
    // removed entity A: tombstoned record, lastEntityId "light.living"
    const keyA = keyOf("light.living", "UA", "hue");
    store.set("b", keyA, aged("light.living"));
    // live entity B reused the same entity_id with a DIFFERENT unique_id, so a
    // different identity key, and holds its own custom mapping under that id
    const keyB = keyOf("light.living", "UB", "hue");
    store.set("b", keyB, {
      endpointId: "e",
      anchorEntityId: "light.living",
      lastEntityId: "light.living",
    });
    mappings.put("b", "light.living");

    const results = await executeOrphanCleanup({
      bridgeId: "b",
      requestedKeys: [keyA],
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set([keyB]),
      presentEntityIds: new Set(["light.living"]),
      getMapping: (b, e) => mappings.getMapping(b, e),
      deleteMapping: (b, e) => mappings.deleteMapping(b, e),
      deleteIdentity: (b, k) => store.deleteIdentity(b, k),
      now: NOW,
    });

    // A's tombstoned identity record is cleaned...
    expect(results[0].deleted).toBe(true);
    expect(store.get("b", keyA)).toBeUndefined();
    // ...but B's live mapping under the reused entity_id must survive
    expect(mappings.getMapping("b", "light.living")).toBeDefined();
    expect(store.get("b", keyB)).toBeDefined();
  });
});

describe("computeOrphanCandidates stray mappings", () => {
  const agedIso = new Date(NOW - 8 * DAY).toISOString();

  // The Codex repro: with stableIdentity off, a rename moves the record's
  // lastEntityId to light.new but leaves the mapping at light.old. The identity
  // row then reports no mapping (its lastEntityId is light.new), so the light.old
  // mapping is only reachable as its own stray-mapping row.
  it("offers a stray mapping whose entity is gone (flag-off rename left it behind)", () => {
    const key = keyOf("light.new", "U", "hue");
    const identities = new Map<string, IdentityRecord>([
      [
        key,
        {
          endpointId: "e",
          anchorEntityId: "light.old",
          lastEntityId: "light.new",
          missingSince: agedIso,
        },
      ],
    ]);
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities,
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: (e) => e === "light.old",
      mappings: [{ entityId: "light.old", missingSince: agedIso }],
      now: NOW,
    });

    const identityRow = candidates.find((c) => c.kind === "identity");
    expect(identityRow?.lastEntityId).toBe("light.new");
    expect(identityRow?.hasMapping).toBe(false);

    const mappingRow = candidates.find((c) => c.kind === "mapping");
    expect(mappingRow).toBeDefined();
    expect(mappingRow?.identityKey).toBe("light.old");
    expect(mappingRow?.lastEntityId).toBe("light.old");
    expect(mappingRow?.hasMapping).toBe(true);
  });

  it("offers a keyless entity's stray mapping (no identity record at all)", () => {
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities: new Map(),
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: (e) => e === "light.keyless",
      mappings: [{ entityId: "light.keyless", missingSince: agedIso }],
      now: NOW,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("mapping");
    expect(candidates[0].lastEntityId).toBe("light.keyless");
  });

  it("does not offer a stray mapping younger than the window", () => {
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities: new Map(),
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: () => true,
      mappings: [
        {
          entityId: "light.recent",
          missingSince: new Date(NOW - 3 * DAY).toISOString(),
        },
      ],
      now: NOW,
    });
    expect(candidates).toEqual([]);
  });

  it("never offers a PRESENT mapping (entity still live under that id)", () => {
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities: new Map(),
      presentKeys: new Set(),
      presentEntityIds: new Set(["light.old"]),
      hasMapping: () => true,
      mappings: [{ entityId: "light.old", missingSince: agedIso }],
      now: NOW,
    });
    expect(candidates).toEqual([]);
  });

  it("does not double-offer a mapping an identity candidate already links", () => {
    const key = keyOf("light.new", "U", "hue");
    const identities = new Map<string, IdentityRecord>([
      [
        key,
        {
          endpointId: "e",
          anchorEntityId: "light.new",
          lastEntityId: "light.new",
          missingSince: agedIso,
        },
      ],
    ]);
    const candidates = computeOrphanCandidates({
      bridgeId: "b",
      identities,
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      hasMapping: (e) => e === "light.new",
      mappings: [{ entityId: "light.new", missingSince: agedIso }],
      now: NOW,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("identity");
    expect(candidates[0].hasMapping).toBe(true);
  });

  it("executes a stray-mapping candidate through deleteMapping", async () => {
    const store = new FakeIdentityStore();
    const mappings = new FakeMappingStore();
    mappings.put("b", "light.old", agedIso);

    const results = await executeOrphanCleanup({
      bridgeId: "b",
      requestedKeys: ["light.old"],
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set(),
      presentEntityIds: new Set(),
      getMapping: (b, e) => mappings.getMapping(b, e),
      deleteMapping: (b, e) => mappings.deleteMapping(b, e),
      deleteIdentity: (b, k) => store.deleteIdentity(b, k),
      mappings: mappings.getMappingsForBridge("b"),
      now: NOW,
    });

    expect(results[0]).toEqual({ identityKey: "light.old", deleted: true });
    expect(mappings.getMapping("b", "light.old")).toBeUndefined();
  });

  it("keeps a PRESENT stray-mapping candidate untouched on execute", async () => {
    const store = new FakeIdentityStore();
    const mappings = new FakeMappingStore();
    mappings.put("b", "light.old", agedIso);

    const results = await executeOrphanCleanup({
      bridgeId: "b",
      requestedKeys: ["light.old"],
      identities: store.getBridgeIdentities("b"),
      presentKeys: new Set(),
      // entity reappeared under the same id since the dry-run
      presentEntityIds: new Set(["light.old"]),
      getMapping: (b, e) => mappings.getMapping(b, e),
      deleteMapping: (b, e) => mappings.deleteMapping(b, e),
      deleteIdentity: (b, k) => store.deleteIdentity(b, k),
      mappings: mappings.getMappingsForBridge("b"),
      now: NOW,
    });

    expect(results[0].deleted).toBe(false);
    expect(mappings.getMapping("b", "light.old")).toBeDefined();
  });
});

describe("stampMappingPresence", () => {
  it("stamps a mapping whose entity is gone once and clears it on return", () => {
    const mappings = new FakeMappingStore();
    mappings.put("b", "light.gone");

    stampMappingPresence(mappings, "b", new Set(), NOW);
    expect(mappings.getMapping("b", "light.gone")?.missingSince).toBe(
      new Date(NOW).toISOString(),
    );

    // a later absent pass keeps the first-seen time
    stampMappingPresence(mappings, "b", new Set(), NOW + DAY);
    expect(mappings.getMapping("b", "light.gone")?.missingSince).toBe(
      new Date(NOW).toISOString(),
    );

    // entity returns: tombstone cleared
    stampMappingPresence(mappings, "b", new Set(["light.gone"]), NOW + 2 * DAY);
    expect(
      mappings.getMapping("b", "light.gone")?.missingSince,
    ).toBeUndefined();
  });
});
