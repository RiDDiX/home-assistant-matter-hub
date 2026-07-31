import type { HomeAssistantEntityRegistry } from "@home-assistant-matter-hub/common";
import { identityKey } from "../bridges/identity-resolver.js";
import type { IdentityRecord } from "./entity-identity-storage.js";

// An identity record has to be absent from HA this long before the manual
// cleanup will offer it. The window rides out an HA restart or a temporary
// integration outage: the entity returns, the tombstone clears, and the record
// never becomes a candidate.
export const ORPHAN_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrphanCandidate {
  // For an identity row this is the stable identity key. For a mapping-only row
  // (a stray custom mapping with no reachable identity record) it is the mapping
  // entityId, which is also how execute keys it back.
  identityKey: string;
  lastEntityId: string;
  missingSince: string;
  hasMapping: boolean;
  kind: "identity" | "mapping";
}

export interface OrphanCleanupResult {
  identityKey: string;
  deleted: boolean;
  reason?: string;
}

// The identity keys of every entity in the FULL HA registry (not a bridge's
// filtered set), so a filter change or a scope narrowing never reads as a
// removal. Entities with no unique_id/platform have no key and are skipped;
// they never get an identity record either.
export function buildPresentIdentityKeys(
  entities: Record<string, HomeAssistantEntityRegistry>,
): Set<string> {
  const keys = new Set<string>();
  for (const entity of Object.values(entities ?? {})) {
    if (!entity?.entity_id) continue;
    const key = identityKey({ entity_id: entity.entity_id, registry: entity });
    if (key != null) keys.add(key);
  }
  return keys;
}

// The entity_ids every entity in the FULL HA registry currently holds. A
// tombstoned record carries the entity_id its removed entity last had, but that
// same entity_id can be reused by a DIFFERENT live entity (new unique_id, so a
// different identity key) that has its own custom mapping. This set lets the
// cleanup tell "a lingering mapping for a gone entity" from "a live entity's
// mapping under a reused id", so it never sweeps the latter.
export function buildPresentEntityIds(
  entities: Record<string, HomeAssistantEntityRegistry>,
): Set<string> {
  const ids = new Set<string>();
  for (const entity of Object.values(entities ?? {})) {
    if (entity?.entity_id) ids.add(entity.entity_id);
  }
  return ids;
}

interface IdentityPresenceStore {
  getBridgeIdentities(bridgeId: string): ReadonlyMap<string, IdentityRecord>;
  markIdentityMissing(bridgeId: string, key: string, nowIso: string): void;
  clearIdentityMissing(bridgeId: string, key: string): void;
}

// Walk a bridge's stored identity records and reconcile each tombstone against
// the current full registry: stamp missingSince on first absence, clear it on
// return. Never deletes anything; ageing a tombstone into a candidate and the
// delete both happen elsewhere, only on an explicit user action.
export function stampIdentityPresence(
  store: IdentityPresenceStore,
  bridgeId: string,
  presentKeys: ReadonlySet<string>,
  now: number = Date.now(),
): void {
  const nowIso = new Date(now).toISOString();
  // Snapshot the keys first, the mark/clear calls mutate the same records.
  for (const key of [...store.getBridgeIdentities(bridgeId).keys()]) {
    if (presentKeys.has(key)) {
      store.clearIdentityMissing(bridgeId, key);
    } else {
      store.markIdentityMissing(bridgeId, key, nowIso);
    }
  }
}

interface MappingPresenceStore {
  getMappingsForBridge(bridgeId: string): ReadonlyArray<{ entityId: string }>;
  markMappingMissing(bridgeId: string, entityId: string, nowIso: string): void;
  clearMappingMissing(bridgeId: string, entityId: string): void;
}

// The mapping sibling of stampIdentityPresence, keyed by entity_id against the
// full registry. It catches mappings the identity tombstone cannot: a flag-off
// rename moves the record's lastEntityId but leaves the mapping at the old id,
// and a keyless entity (no unique_id) has no identity record at all. Stamp on
// first absence, clear on return, never delete.
export function stampMappingPresence(
  store: MappingPresenceStore,
  bridgeId: string,
  presentEntityIds: ReadonlySet<string>,
  now: number = Date.now(),
): void {
  const nowIso = new Date(now).toISOString();
  // Snapshot first, the mark/clear calls mutate the same records.
  const entityIds = store.getMappingsForBridge(bridgeId).map((m) => m.entityId);
  for (const entityId of entityIds) {
    if (presentEntityIds.has(entityId)) {
      store.clearMappingMissing(bridgeId, entityId);
    } else {
      store.markMappingMissing(bridgeId, entityId, nowIso);
    }
  }
}

export interface ComputeOrphansInput {
  bridgeId: string;
  identities: ReadonlyMap<string, IdentityRecord>;
  presentKeys: ReadonlySet<string>;
  presentEntityIds: ReadonlySet<string>;
  hasMapping(entityId: string): boolean;
  // The bridge's stored custom mappings with their own tombstone. Optional so a
  // caller that only cares about identity records can omit it; when given, stray
  // mappings become candidates too.
  mappings?: ReadonlyArray<{ entityId: string; missingSince?: string }>;
  now?: number;
}

// A record is a candidate when its tombstone is older than ORPHAN_TOMBSTONE_MS
// AND its key is still absent from the full registry right now (a re-check, so an
// entity that reappeared since the last refresh but has not been re-stamped yet
// is not offered).
export function computeOrphanCandidates(
  input: ComputeOrphansInput,
): OrphanCandidate[] {
  const now = input.now ?? Date.now();
  const candidates: OrphanCandidate[] = [];
  for (const [key, record] of input.identities) {
    if (!record.missingSince) continue;
    const missingFor = now - Date.parse(record.missingSince);
    if (!(missingFor >= ORPHAN_TOMBSTONE_MS)) continue;
    if (input.presentKeys.has(key)) continue;
    // On rename the mapping is re-keyed to lastEntityId, so that is where a
    // lingering mapping for this identity lives; fall back to the anchor.
    const lastEntityId = record.lastEntityId ?? record.anchorEntityId;
    candidates.push({
      identityKey: key,
      lastEntityId,
      missingSince: record.missingSince,
      // Only a true orphan mapping, not one a live entity holds under a reused
      // entity_id (a different identity key). Guards the sweep from clobbering
      // that live entity's custom mapping.
      hasMapping:
        input.hasMapping(lastEntityId) &&
        !input.presentEntityIds.has(lastEntityId),
      kind: "identity",
    });
  }

  // Stray custom mappings whose entity is gone: a flag-off rename that left the
  // mapping at the old id, or a keyless entity that never had an identity
  // record. Same 7-day window and same present-entity guard as the identity
  // tombstone. Skip a mapping an identity row already links (its hasMapping),
  // so a single mapping never shows as two rows.
  if (input.mappings) {
    const linkedByIdentity = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.hasMapping) linkedByIdentity.add(candidate.lastEntityId);
    }
    for (const mapping of input.mappings) {
      if (!mapping.missingSince) continue;
      const missingFor = now - Date.parse(mapping.missingSince);
      if (!(missingFor >= ORPHAN_TOMBSTONE_MS)) continue;
      if (input.presentEntityIds.has(mapping.entityId)) continue;
      if (linkedByIdentity.has(mapping.entityId)) continue;
      candidates.push({
        identityKey: mapping.entityId,
        lastEntityId: mapping.entityId,
        missingSince: mapping.missingSince,
        hasMapping: true,
        kind: "mapping",
      });
    }
  }

  return candidates;
}

export interface ExecuteOrphansInput {
  bridgeId: string;
  requestedKeys: string[];
  identities: ReadonlyMap<string, IdentityRecord>;
  presentKeys: ReadonlySet<string>;
  presentEntityIds: ReadonlySet<string>;
  getMapping(bridgeId: string, entityId: string): unknown;
  deleteMapping(bridgeId: string, entityId: string): Promise<void>;
  deleteIdentity(bridgeId: string, key: string): Promise<void>;
  mappings?: ReadonlyArray<{ entityId: string; missingSince?: string }>;
  now?: number;
}

// Deletes only keys that a fresh candidate computation still lists (which
// re-checks absence), so a key whose entity returned between the dry-run and the
// POST is skipped rather than deleted. An identity row drops its record and the
// mapping linked to it (matched by lastEntityId/anchor). A stray-mapping row
// (its own tombstone, no reachable identity record) drops just that mapping. A
// mapping whose entity_id a live entity still holds (reused id, different key)
// is left untouched in either path.
export async function executeOrphanCleanup(
  input: ExecuteOrphansInput,
): Promise<OrphanCleanupResult[]> {
  const candidates = computeOrphanCandidates({
    bridgeId: input.bridgeId,
    identities: input.identities,
    presentKeys: input.presentKeys,
    presentEntityIds: input.presentEntityIds,
    hasMapping: (entityId) =>
      input.getMapping(input.bridgeId, entityId) != null,
    mappings: input.mappings,
    now: input.now,
  });
  const byKey = new Map(candidates.map((c) => [c.identityKey, c]));

  const results: OrphanCleanupResult[] = [];
  for (const key of input.requestedKeys) {
    const candidate = byKey.get(key);
    if (!candidate) {
      results.push({
        identityKey: key,
        deleted: false,
        reason: "not a current orphan candidate",
      });
      continue;
    }
    // A stray-mapping row has no identity record to drop: delete just the
    // mapping, guarded so a reappeared entity's mapping is never swept.
    if (candidate.kind === "mapping") {
      if (!input.presentEntityIds.has(candidate.lastEntityId)) {
        await input.deleteMapping(input.bridgeId, candidate.lastEntityId);
      }
      results.push({ identityKey: key, deleted: true });
      continue;
    }
    // candidate.hasMapping already excludes a reused, live entity_id; re-check
    // it here so the delete never fires for a live entity's mapping even if the
    // candidate flag is ever computed differently.
    if (
      candidate.hasMapping &&
      !input.presentEntityIds.has(candidate.lastEntityId)
    ) {
      await input.deleteMapping(input.bridgeId, candidate.lastEntityId);
    }
    await input.deleteIdentity(input.bridgeId, key);
    results.push({ identityKey: key, deleted: true });
  }
  return results;
}
