import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import type { HomeAssistantStates } from "../home-assistant/home-assistant-registry.js";
import { type BridgeRegistry, fingerprintBattery } from "./bridge-registry.js";

// Mapping fingerprints and the battery auto-map catch-up (#450), shared by
// the aggregator and the server mode endpoint manager. Both carried this
// twice and every fix had to land in each copy.
export class EntityMappingSync {
  private retryScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  // deviceId -> primary entityId of endpoints that auto-map but carry no
  // battery, bounds the per-state-batch check to a map hit
  private readonly candidates = new Map<string, string>();

  constructor(
    private readonly registry: BridgeRegistry,
    private readonly getMapping: (
      entityId: string,
    ) => EntityMappingConfig | undefined,
    private readonly log: Logger,
  ) {}

  // Only endpoints the auto-mapping applies to belong in the candidates: a
  // manual or disabled mapping, or a sensor endpoint sharing the device,
  // must not claim the slot (last writer would win) and stall the recovery.
  eligible(entityId: string): boolean {
    const mapping = this.getMapping(entityId);
    if (mapping?.batteryEntity || mapping?.disableBatteryMapping) return false;
    if (
      entityId.startsWith("sensor.") ||
      entityId.startsWith("binary_sensor.")
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
    const fingerprint = this.computeFingerprint(mapping, entityId);
    if (fingerprintBattery(fingerprint) != null || !storedFingerprint)
      return fingerprint;
    if (!this.eligible(entityId)) return fingerprint;
    const battery = fingerprintBattery(storedFingerprint);
    if (!battery) return fingerprint;
    const deviceId = this.registry.entity(entityId)?.device_id;
    const stillSameDevice =
      !!deviceId && this.registry.fullEntities[battery]?.device_id === deviceId;
    return stillSameDevice
      ? JSON.stringify([mapping ?? null, battery])
      : fingerprint;
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
    return (mappedEntityIds ?? []).includes(battery)
      ? fingerprint
      : JSON.stringify([mapping ?? null, null]);
  }

  rebuildCandidates(entries: Iterable<[string, string]>): void {
    this.candidates.clear();
    for (const [entityId, fingerprint] of entries) {
      if (fingerprintBattery(fingerprint) != null) continue;
      if (!this.eligible(entityId)) continue;
      const deviceId = this.registry.entity(entityId)?.device_id;
      if (deviceId) this.candidates.set(deviceId, entityId);
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
    if (!observing || this.retryScheduled || this.candidates.size === 0) {
      return;
    }
    for (const id of changed ?? Object.keys(states)) {
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
      this.retryScheduled = true;
      this.log.info(
        `Battery sensor ${resolved} appeared for ${entityId}, rebuilding`,
      );
      // flag stays set until the refresh completes, no concurrent reconcile
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        refresh()
          .catch((e) => this.log.warn("Battery retry refresh failed:", e))
          .finally(() => {
            this.retryScheduled = false;
          });
      }, 0);
      return;
    }
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
