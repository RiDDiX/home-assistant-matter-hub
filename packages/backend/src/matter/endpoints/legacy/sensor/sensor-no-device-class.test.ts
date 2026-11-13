import type {
  DiagnosticEvent,
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticEventBus } from "../../../../services/diagnostics/diagnostic-event-bus.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

function entity(entityId: string): HomeAssistantEntityInformation {
  const state = {
    entity_id: entityId,
    state: "21.5",
    attributes: { friendly_name: "Min max", unit_of_measurement: "°C" },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: state as any };
}

let events: DiagnosticEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  events = [];
  unsubscribe = diagnosticEventBus.subscribe((e) => events.push(e));
});

afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe("sensor without device_class", () => {
  it("is skipped with one diagnostic over two refreshes", () => {
    const id = "sensor.min_max_skipped";
    const warn = vi.spyOn(Logger.prototype, "warn");
    const debug = vi.spyOn(Logger.prototype, "debug");
    expect(createLegacyEndpointType(entity(id), { entityId: id })).toBe(
      undefined,
    );
    expect(createLegacyEndpointType(entity(id), { entityId: id })).toBe(
      undefined,
    );
    const mine = events.filter((e) => e.entityId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0].type).toBe("entity_warning");
    expect(mine[0].message).toContain("no device_class");
    expect(mine[0].message).toContain("°C");
    expect(warn).not.toHaveBeenCalledWith(mine[0].message);
    expect(debug).toHaveBeenCalledWith(mine[0].message);
  });

  it("is exposed without a diagnostic under a device type override", () => {
    const id = "sensor.min_max_override";
    const mapping: EntityMappingConfig = {
      entityId: id,
      matterDeviceType: "temperature_sensor",
    };
    expect(createLegacyEndpointType(entity(id), mapping)).toBeDefined();
    expect(events.filter((e) => e.entityId === id)).toHaveLength(0);
  });
});
