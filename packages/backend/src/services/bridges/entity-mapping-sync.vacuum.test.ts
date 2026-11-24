import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import { describe, expect, it, vi } from "vitest";
import type { BridgeRegistry } from "./bridge-registry.js";
import { EntityMappingSync } from "./entity-mapping-sync.js";

const VACUUM = "vacuum.robot";

function vacuum(value: string, rooms?: unknown): HomeAssistantEntityState {
  return {
    entity_id: VACUUM,
    state: value,
    attributes: { friendly_name: "Robot", ...(rooms ? { rooms } : {}) },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

const ROOMS = { 9: "Office", 6: "Kitchen" };

function makeSync() {
  let current: HomeAssistantEntityState | undefined;
  const registry = {
    initialState: () => current,
    batteryFingerprintFor: () => "",
    entity: () => undefined,
    fullEntities: {},
    isAutoBatteryMappingEnabled: () => false,
  } as unknown as BridgeRegistry;
  const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const sync = new EntityMappingSync(registry, () => undefined, log);
  return {
    sync,
    set(state: HomeAssistantEntityState | undefined) {
      current = state;
    },
  };
}

describe("vacuum room fingerprint", () => {
  it("carries the sorted area ids, null while unavailable or roomless", () => {
    const { sync, set } = makeSync();
    set(vacuum("docked", ROOMS));
    expect(JSON.parse(sync.computeFingerprint(undefined, VACUUM))[2]).toBe(
      "[6,9]",
    );
    set(vacuum("unavailable", ROOMS));
    expect(JSON.parse(sync.computeFingerprint(undefined, VACUUM))[2]).toBe(
      null,
    );
    set(vacuum("docked"));
    expect(JSON.parse(sync.computeFingerprint(undefined, VACUUM))[2]).toBe(
      null,
    );
  });

  it("keeps the stored rooms when the live ones are gone", () => {
    const { sync, set } = makeSync();
    set(vacuum("docked", ROOMS));
    const stored = sync.computeFingerprint(undefined, VACUUM);
    set(vacuum("docked"));
    expect(sync.compareFingerprint(undefined, VACUUM, stored)).toBe(stored);
    set(vacuum("unavailable"));
    expect(sync.compareFingerprint(undefined, VACUUM, stored)).toBe(stored);
  });

  it("differs once rooms arrive on a vacuum built without them", () => {
    const { sync, set } = makeSync();
    set(vacuum("unavailable"));
    const stored = sync.computeFingerprint(undefined, VACUUM);
    set(vacuum("docked", ROOMS));
    expect(sync.compareFingerprint(undefined, VACUUM, stored)).not.toBe(stored);
  });

  it("schedules one refresh when the live rooms differ from the built ones", async () => {
    const { sync, set } = makeSync();
    set(vacuum("unavailable"));
    sync.rebuildCandidates([
      [VACUUM, sync.computeFingerprint(undefined, VACUUM)],
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const changed = new Set([VACUUM]);

    sync.maybeRetry({ [VACUUM]: vacuum("docked") }, changed, true, refresh);
    expect(sync.retryPending).toBe(false);

    sync.maybeRetry(
      { [VACUUM]: vacuum("docked", ROOMS) },
      changed,
      true,
      refresh,
    );
    expect(sync.retryPending).toBe(true);
    await vi.waitFor(() => expect(sync.retryPending).toBe(false));
    expect(refresh).toHaveBeenCalledTimes(1);

    // same rooms again: nothing new to build
    sync.maybeRetry(
      { [VACUUM]: vacuum("cleaning", ROOMS) },
      changed,
      true,
      refresh,
    );
    expect(sync.retryPending).toBe(false);
  });
});
