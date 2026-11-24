import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeDataProvider } from "../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../services/bridges/bridge-registry.js";
import type { HomeAssistantRegistry } from "../../../services/home-assistant/home-assistant-registry.js";
import { updateEntityState } from "../update-entity-state.js";
import { LegacyEndpoint } from "./legacy-endpoint.js";

vi.mock("../update-entity-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../update-entity-state.js")>()),
  updateEntityState: vi.fn(async () => {}),
}));

// A failed write used to leave the endpoint on the old value: the replay of
// the same state was deduped until Home Assistant changed the entity.

const SWITCH = "switch.outlet";
const BATTERY = "sensor.outlet_battery";
const EVENT = "event.doorbell";

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    device_id: "dev1",
    entity_id: entityId,
    id: entityId,
    labels: [],
    original_name: entityId,
    platform: "test",
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

async function create(entityId: string, mapping?: { batteryEntity: string }) {
  const states: Record<string, HomeAssistantEntityState> = {
    [SWITCH]: state(SWITCH, "on"),
    [BATTERY]: state(BATTERY, "80", { device_class: "battery" }),
    [EVENT]: state(EVENT, "unknown", { event_types: ["ring"] }),
  };
  const registry = {
    areas: new Map(),
    devices: {},
    entities: Object.fromEntries(
      Object.keys(states).map((id) => [id, registryEntity(id)]),
    ),
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    featureFlags: {},
    filter: { include: [], exclude: [], includeMode: "any" },
  } as unknown as BridgeDataProvider;
  const endpoint = await LegacyEndpoint.create(
    new BridgeRegistry(registry, dataProvider),
    entityId,
    mapping ? { entityId, ...mapping } : undefined,
  );
  expect(endpoint).toBeDefined();
  return endpoint!;
}

const flush = () => new Promise((r) => setTimeout(r, 80));
const write = vi.mocked(updateEntityState);

describe("LegacyEndpoint failed write retry", () => {
  beforeEach(() => {
    write.mockReset();
    write.mockResolvedValue(undefined);
  });

  it("writes the same state again once after a failed write", async () => {
    const endpoint = await create(SWITCH);
    const states = { [SWITCH]: state(SWITCH, "off") };
    write.mockRejectedValueOnce(new Error("lock"));

    await endpoint.updateStates(states);
    await flush();
    await endpoint.updateStates(states);
    await flush();
    await endpoint.updateStates(states);
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the retry fails as well", async () => {
    const endpoint = await create(SWITCH);
    const states = { [SWITCH]: state(SWITCH, "off") };
    write.mockRejectedValue(new Error("lock"));

    for (let i = 0; i < 4; i++) {
      await endpoint.updateStates(states);
      await flush();
    }

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("keeps the mapped change bump for the retry", async () => {
    const endpoint = await create(SWITCH, { batteryEntity: BATTERY });
    const primary = state(SWITCH, "on");
    await endpoint.updateStates({
      [SWITCH]: primary,
      [BATTERY]: state(BATTERY, "80"),
    });
    await flush();
    write.mockReset();
    write.mockRejectedValueOnce(new Error("lock"));

    const states = { [SWITCH]: primary, [BATTERY]: state(BATTERY, "40") };
    await endpoint.updateStates(states);
    await flush();
    await endpoint.updateStates(states);
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
    const retried = write.mock.calls[1][1]!;
    expect(retried.last_updated).not.toBe(primary.last_updated);
  });

  it("keeps the mapped change bump when a newer state replaced the failed one", async () => {
    const endpoint = await create(SWITCH, { batteryEntity: BATTERY });
    const primary = state(SWITCH, "on");
    await endpoint.updateStates({
      [SWITCH]: primary,
      [BATTERY]: state(BATTERY, "80"),
    });
    await flush();
    write.mockReset();
    let reject!: (e: Error) => void;
    write.mockImplementationOnce(
      () => new Promise<void>((_, r) => (reject = r)),
    );
    write.mockResolvedValue(undefined);

    const battery = state(BATTERY, "40");
    await endpoint.updateStates({ [SWITCH]: primary, [BATTERY]: battery });
    await flush();
    const newer = state(SWITCH, "off");
    await endpoint.updateStates({ [SWITCH]: newer, [BATTERY]: battery });
    reject(new Error("lock"));
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][1]!.last_updated).not.toBe(newer.last_updated);
  });

  it("retries again after an earlier retry of the same state succeeded", async () => {
    const endpoint = await create(SWITCH, { batteryEntity: BATTERY });
    const primary = state(SWITCH, "off");
    const first = { [SWITCH]: primary, [BATTERY]: state(BATTERY, "80") };
    write.mockRejectedValueOnce(new Error("lock"));
    await endpoint.updateStates(first);
    await flush();
    await endpoint.updateStates(first);
    await flush();
    expect(write).toHaveBeenCalledTimes(2);

    const mapped = { [SWITCH]: primary, [BATTERY]: state(BATTERY, "40") };
    write.mockRejectedValueOnce(new Error("lock"));
    await endpoint.updateStates(mapped);
    await flush();
    await endpoint.updateStates(mapped);
    await flush();

    expect(write).toHaveBeenCalledTimes(4);
  });

  it("does not retry an event entity", async () => {
    const endpoint = await create(EVENT);
    const states = {
      [EVENT]: state(EVENT, "2026-01-01T00:00:01", {
        event_types: ["ring"],
        event_type: "ring",
      }),
    };
    write.mockRejectedValueOnce(new Error("lock"));

    await endpoint.updateStates(states);
    await flush();
    await endpoint.updateStates(states);
    await flush();

    expect(write).toHaveBeenCalledTimes(1);
  });
});
