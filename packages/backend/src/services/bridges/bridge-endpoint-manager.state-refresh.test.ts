import { describe, expect, it, vi } from "vitest";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { BridgeEndpointManager } from "./bridge-endpoint-manager.js";

describe("BridgeEndpointManager state refresh", () => {
  it("reconciles only entities that have a fresh registry state", async () => {
    const primary = {
      entityId: "cover.blind",
      mappedEntityIds: ["sensor.blind_battery"],
    } as unknown as EntityEndpoint;
    const missing = {
      entityId: "light.missing",
      mappedEntityIds: [],
    } as unknown as EntityEndpoint;
    const manager = Object.create(BridgeEndpointManager.prototype) as any;
    manager.entityIds = ["cover.blind", "light.missing"];
    manager.root = { parts: [primary, missing] };
    manager.registry = {
      initialStateIncludingUnfiltered: vi.fn((id: string) => {
        if (id === "cover.blind") {
          return {
            entity_id: id,
            state: "open",
            attributes: { current_position: 100 },
          };
        }
        if (id === "sensor.blind_battery") {
          return {
            entity_id: id,
            state: "88",
            attributes: { device_class: "battery" },
          };
        }
        return undefined;
      }),
    };
    manager.updateStates = vi.fn().mockResolvedValue(undefined);

    await manager.refreshStatesFromRegistry();

    const expectedStates = {
      "cover.blind": {
        entity_id: "cover.blind",
        state: "open",
        attributes: { current_position: 100 },
      },
      "sensor.blind_battery": {
        entity_id: "sensor.blind_battery",
        state: "88",
        attributes: { device_class: "battery" },
      },
    };
    const expectedChanged = new Set([
      "cover.blind",
      "sensor.blind_battery",
    ]);
    expect(manager.updateStates).toHaveBeenCalledWith(
      expectedStates,
      expectedChanged,
    );
  });
});
