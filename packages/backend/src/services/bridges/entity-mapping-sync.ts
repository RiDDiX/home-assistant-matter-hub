import type {
  EntityMappingConfig,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import type { HomeAssistantStates } from "../home-assistant/home-assistant-registry.js";
import { type BridgeRegistry, fingerprintBattery } from "./bridge-registry.js";

// #515: a fan's device type and FanControl features are frozen at endpoint
// creation. Speed or direction gained later (LocalTuya configured after the
// bridge started) must change the fingerprint so the endpoint rebuilds.
// null = capabilities unknown right now, the caller keeps the stored value.
function fanCapabilities(
  state: HomeAssistantEntityState | undefined,
): string | null {
  if (!state || state.state === "unavailable" || state.state === "unknown") {
    return null;
  }
  const attributes = (state.attributes ?? {}) as Record<string, unknown>;
  if (attributes.supported_features == null) return null;
  const presets = Array.isArray(attributes.preset_modes)
    ? [...attributes.preset_modes].sort()
    : [];
  return JSON.stringify([attributes.supported_features, presets]);
}

function parseTuple(fingerprint: string): unknown[] {
  try {
    const parsed = JSON.parse(fingerprint);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [fingerprint];
  }
}

// Mapping fingerprints and the battery auto-map catch-up (#450), shared by
// the aggregator and the server mode endpoint manager. Both carried this
// twice and every fix had to land in each copy.
export class EntityMappingSync {
  private retryScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // deviceId -> primary entityId of endpoints that auto-map but carry no
  // battery, bounds the per-state-batch check to a map hit
  private readonly candidates = new Map<string, string>();
  // fan entityId -> as-built capability element of its fingerprint (#515)
  private readonly fanCaps = new Map<string, string | null>();

  constructor(
    private readonly registry: BridgeRegistry,
    private readonly getMapping: (
      entityId: string,
    ) => EntityMappingConfig | undefined,
    private readonly log: Logger,
  ) {}

  // Only endpoints the auto-mapping applies to belong in the candidates: a
  // manual or disabled mapping, or the battery sensor's own endpoint, must
  // not claim the slot (last writer would win) and stall the recovery.
  eligible(entityId: string): boolean {
    const mapping = this.getMapping(entityId);
    if (mapping?.batteryEntity || mapping?.disableBatteryMapping) return false;
    if (entityId.startsWith("binary_sensor.")) return false;
    if (
      entityId.startsWith("sensor.") &&
      this.registry.initialState(entityId)?.attributes?.device_class ===
        "battery"
    ) {
      return false;
    }
    return (
      entityId.startsWith("vacuum.") ||
      !!this.registry.isAutoBatteryMappingEnabled?.()
    );
  }

  // the auto-resolved battery is part of the endpoint shape, so a sensor
  // that appears later must change the fingerprint and rebuild. JSON tuple
  // so mapping text can never collide with a battery marker.
  computeFingerprint(
    mapping: EntityMappingConfig | undefined,
    entityId?: string,
  ): string {
    const battery = entityId
      ? this.registry.batteryFingerprintFor(entityId, mapping)
      : "";
    // fans carry a third capability element (#515); other domains keep the
    // two-element tuple so their stored fingerprints stay valid
    if (entityId?.startsWith("fan.")) {
      const caps = fanCapabilities(this.registry.initialState(entityId));
      return JSON.stringify([mapping ?? null, battery || null, caps]);
    }
    return JSON.stringify([mapping ?? null, battery || null]);
  }

  // Live fingerprint for reconcile compares: when the resolver finds nothing
  // right now but the stored fingerprint maps a sensor that still exists on
  // the SAME device, keep it. An unavailable snapshot (HA restart) must not
  // strip the mapping and rebuild the endpoint battery-less.
  compareFingerprint(
    mapping: EntityMappingConfig | undefined,
    entityId: string,
    storedFingerprint: string | undefined,
  ): string {
    let fingerprint = this.computeFingerprint(mapping, entityId);
    // #515: unknown live capabilities (unavailable snapshot, integrations
    // stripping attributes) must not rebuild the fan, keep the stored element.
    if (entityId.startsWith("fan.") && storedFingerprint) {
      const live = parseTuple(fingerprint);
      const stored = parseTuple(storedFingerprint);
      if (live[2] == null && stored.length > 2 && stored[2] != null) {
        live[2] = stored[2];
        fingerprint = JSON.stringify(live);
      }
    }
    if (fingerprintBattery(fingerprint) != null || !storedFingerprint)
      return fingerprint;
    if (!this.eligible(entityId)) return fingerprint;
    const battery = fingerprintBattery(storedFingerprint);
    if (!battery) return fingerprint;
    const deviceId = this.registry.entity(entityId)?.device_id;
    const stillSameDevice =
      !!deviceId && this.registry.fullEntities[battery]?.device_id === deviceId;
    if (!stillSameDevice) return fingerprint;
    const merged = parseTuple(fingerprint);
    merged[1] = battery;
    return JSON.stringify(merged);
  }

  // The stored fingerprint must reflect what the endpoint actually maps: a
  // battery resolved while it was built without one (sensor outage during a
  // forced rebuild) would otherwise never trigger the catch-up.
  fingerprintAsBuilt(
    mapping: EntityMappingConfig | undefined,
    entityId: string,
    mappedEntityIds: readonly string[] | undefined,
  ): string {
    const fingerprint = this.computeFingerprint(mapping, entityId);
    const battery = fingerprintBattery(fingerprint);
    if (battery == null) return fingerprint;
    if ((mappedEntityIds ?? []).includes(battery)) return fingerprint;
    const parsed = parseTuple(fingerprint);
    parsed[1] = null;
    return JSON.stringify(parsed);
  }

  rebuildCandidates(entries: Iterable<[string, string]>): void {
    this.candidates.clear();
    this.fanCaps.clear();
    for (const [entityId, fingerprint] of entries) {
      // track the as-built capability element of every fan endpoint (#515)
      if (entityId.startsWith("fan.")) {
        const tuple = parseTuple(fingerprint);
        this.fanCaps.set(
          entityId,
          tuple.length > 2 && typeof tuple[2] === "string" ? tuple[2] : null,
        );
      }
      if (fingerprintBattery(fingerprint) != null) continue;
      if (!this.eligible(entityId)) continue;
      const deviceId = this.registry.entity(entityId)?.device_id;
      if (!deviceId) continue;
      // a sibling sensor never displaces the vacuum or other primary
      const owner = this.candidates.get(deviceId);
      if (
        owner &&
        !owner.startsWith("sensor.") &&
        entityId.startsWith("sensor.")
      ) {
        continue;
      }
      this.candidates.set(deviceId, entityId);
    }
  }

  // battery-less auto-map endpoints watch their device's sensors, an
  // unresolved battery is not mapped so it would never arrive otherwise
  candidateSensorIds(): string[] {
    if (this.candidates.size === 0) return [];
    const ids: string[] = [];
    for (const entity of Object.values(this.registry.fullEntities)) {
      if (!entity.device_id) continue;
      if (!this.candidates.has(entity.device_id)) continue;
      if (
        entity.entity_id.startsWith("sensor.") ||
        entity.entity_id.startsWith("binary_sensor.")
      ) {
        ids.push(entity.entity_id);
      }
    }
    return ids;
  }

  // An endpoint built while its battery sensor was unavailable stays
  // battery-less, because registry ticks only refresh on structural changes.
  // When a same-device sensor state arrives, re-resolve and rebuild once.
  maybeRetry(
    states: HomeAssistantStates,
    changed: ReadonlySet<string> | null,
    observing: boolean,
    refresh: () => Promise<void>,
  ): void {
    // a stop mid-flight leaves queued batches behind, never schedule on a
    // stopped manager
    if (
      !observing ||
      this.retryScheduled ||
      (this.candidates.size === 0 && this.fanCaps.size === 0)
    ) {
      return;
    }
    for (const id of changed ?? Object.keys(states)) {
      // #515: a fan that gained or changed speed/direction capabilities after
      // the endpoint was built keeps its stale plug shape until a refresh.
      if (id.startsWith("fan.")) {
        const stored = this.fanCaps.get(id);
        if (stored === undefined) continue;
        const live = fanCapabilities(states[id]);
        if (live == null || live === stored) continue;
        this.fanCaps.set(id, live);
        this.scheduleRefresh(
          `Fan capabilities changed for ${id}, rebuilding`,
          refresh,
        );
        return;
      }
      if (!id.startsWith("sensor.") && !id.startsWith("binary_sensor."))
        continue;
      const deviceId = this.registry.fullEntities[id]?.device_id;
      if (!deviceId) continue;
      const entityId = this.candidates.get(deviceId);
      if (!entityId) continue;
      this.registry.forgetBatteryCacheForDevice(deviceId);
      const resolved = this.registry.batteryFingerprintFor(
        entityId,
        this.getMapping(entityId),
      );
      if (!resolved) continue;
      this.scheduleRefresh(
        `Battery sensor ${resolved} appeared for ${entityId}, rebuilding`,
        refresh,
      );
      return;
    }
  }

  private scheduleRefresh(reason: string, refresh: () => Promise<void>): void {
    this.retryScheduled = true;
    this.log.info(reason);
    // flag stays set until the refresh completes, no concurrent reconcile
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      refresh()
        .catch((e) => this.log.warn("Mapping retry refresh failed:", e))
        .finally(() => {
          this.retryScheduled = false;
        });
    }, 0);
  }

  cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryScheduled = false;
  }

  get retryPending(): boolean {
    return this.retryScheduled;
  }
}
