import {
  type EntityMappingConfig,
  type HomeAssistantDeviceRegistry,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  type HomeAssistantFilter,
  HomeAssistantMatcherType,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type { HomeAssistantRegistry } from "../home-assistant/home-assistant-registry.js";
import type { BridgeDataProvider } from "./bridge-data-provider.js";
import { BridgeRegistry } from "./bridge-registry.js";
import { FilterTimeoutError } from "./matcher/matches-entity-filter.js";

const deviceId = "device-1";

function device(): HomeAssistantDeviceRegistry {
  return {
    id: deviceId,
    identifiers: [],
    name: "Device",
    labels: [],
  } as unknown as HomeAssistantDeviceRegistry;
}

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: deviceId,
    disabled_by: null,
    entity_category: null,
    entity_id: entityId,
    has_entity_name: false,
    hidden_by: null,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "test",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function state(
  entityId: string,
  value: string,
  attributes: Record<string, unknown>,
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

function sut(
  states: Record<string, HomeAssistantEntityState>,
  featureFlags: Record<string, boolean> = {},
  filter: HomeAssistantFilter = {
    include: [],
    exclude: [],
    includeMode: "any",
  },
  overrides: Record<string, Partial<HomeAssistantEntityRegistry>> = {},
) {
  const entities = Object.fromEntries(
    Object.keys(states).map((entityId) => [
      entityId,
      { ...registryEntity(entityId), ...overrides[entityId] },
    ]),
  );
  const registry = {
    areas: new Map(),
    devices: { [deviceId]: device() },
    entities,
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  const dataProvider = {
    name: "Test",
    featureFlags,
    filter,
  } as unknown as BridgeDataProvider;

  return new BridgeRegistry(registry, dataProvider);
}

const sensors = (
  ...extra: string[]
): Record<string, HomeAssistantEntityState> => ({
  ...Object.fromEntries(
    ["sensor.temperature", ...extra].map((id) => [
      id,
      state(id, "21", { device_class: SensorDeviceClass.temperature }),
    ]),
  ),
  "sensor.humidity": state("sensor.humidity", "40", {
    device_class: SensorDeviceClass.humidity,
  }),
  "sensor.pressure": state("sensor.pressure", "1013", {
    device_class: SensorDeviceClass.pressure,
  }),
});

function refreshWith(
  registry: BridgeRegistry,
  mappings: Record<string, Partial<EntityMappingConfig>>,
) {
  registry.refresh(
    (entityId) => mappings[entityId] && { entityId, ...mappings[entityId] },
  );
}

const temperatureOnly = (exclude: string[] = []): HomeAssistantFilter => {
  const pattern = (value: string) => ({
    type: HomeAssistantMatcherType.Pattern,
    value,
  });
  return {
    include: [pattern("sensor.temperature*")],
    exclude: exclude.map(pattern),
    includeMode: "any",
  };
};

describe("BridgeRegistry temperature companions", () => {
  it("adds humidity and pressure outside the include rules without claiming them", () => {
    const registry = sut(sensors(), {}, temperatureOnly());
    expect(registry.entityIds).toEqual([
      "sensor.temperature",
      "sensor.humidity",
      "sensor.pressure",
    ]);
    expect(registry.isComposedSubEntityUsed("sensor.humidity")).toBe(false);
    expect(registry.isComposedSubEntityUsed("sensor.pressure")).toBe(false);
    expect(
      registry.isTemperatureCompanionSharingBattery("sensor.humidity"),
    ).toBe(true);
    expect(
      registry.isTemperatureCompanionSharingBattery("sensor.pressure"),
    ).toBe(true);
  });

  it("does not promote from a disabled temperature sensor or when auto mapping is off", () => {
    const registry = sut(sensors(), {}, temperatureOnly());
    refreshWith(registry, { "sensor.temperature": { disabled: true } });
    expect(registry.entityIds).toEqual(["sensor.temperature"]);

    const manualOnly = sut(
      sensors(),
      { autoHumidityMapping: false, autoPressureMapping: false },
      temperatureOnly(),
    );
    expect(manualOnly.entityIds).toEqual(["sensor.temperature"]);
  });

  it("continues past hidden, disabled and excluded candidates when choosing a sibling", () => {
    const attrs = { device_class: SensorDeviceClass.humidity };
    const registry = sut(
      {
        "sensor.hidden": state("sensor.hidden", "44", attrs),
        "sensor.disabled": state("sensor.disabled", "44", attrs),
        "sensor.excluded": state("sensor.excluded", "44", attrs),
        "sensor.disabled_mapping": state(
          "sensor.disabled_mapping",
          "44",
          attrs,
        ),
        ...sensors(),
      },
      {},
      temperatureOnly(["sensor.excluded", "sensor.pressure"]),
      {
        "sensor.hidden": { hidden_by: "user" },
        "sensor.disabled": { disabled_by: "user" },
      },
    );
    refreshWith(registry, { "sensor.disabled_mapping": { disabled: true } });
    expect(registry.entityIds).toEqual([
      "sensor.temperature",
      "sensor.humidity",
    ]);
  });

  it("validates manual template sensor roles and deduplicates sources", () => {
    const states = {
      ...sensors("sensor.temperature_2"),
      "sensor.hum_template": state("sensor.hum_template", "40", {
        unit_of_measurement: "%",
      }),
      "sensor.pressure_template": state("sensor.pressure_template", "1013", {
        unit_of_measurement: "hPa",
      }),
    };
    const registry = sut(states, {}, temperatureOnly(), {
      "sensor.hum_template": { device_id: "another-device" },
    });
    const mappings = {
      "sensor.temperature": {
        humidityEntity: "sensor.hum_template",
        pressureEntity: "sensor.pressure_template",
      },
      "sensor.temperature_2": {
        humidityEntity: "sensor.hum_template",
        pressureEntity: "sensor.temperature_2",
      },
    };
    refreshWith(registry, mappings);
    expect(registry.entityIds).toEqual([
      "sensor.temperature",
      "sensor.temperature_2",
      "sensor.hum_template",
      "sensor.pressure_template",
    ]);
    expect(
      registry.initialState("sensor.hum_template")?.attributes.device_class,
    ).toBe("humidity");
    expect(
      registry.initialState("sensor.pressure_template")?.attributes
        .device_class,
    ).toBe("pressure");
    expect(
      registry.isTemperatureCompanionSharingBattery("sensor.hum_template"),
    ).toBe(false);
    states["sensor.hum_template"] = state(
      "sensor.hum_template",
      "unavailable",
      {},
    );
    refreshWith(registry, mappings);
    expect(
      registry.initialState("sensor.hum_template")?.attributes.device_class,
    ).toBe("humidity");
    states["sensor.hum_template"] = state("sensor.hum_template", "50", {
      device_class: SensorDeviceClass.power,
      unit_of_measurement: "%",
    });
    refreshWith(registry, mappings);
    expect(registry.entityIds).not.toContain("sensor.hum_template");
  });

  it("keeps a valid composed child when another candidate enters ahead of it", () => {
    // The earlier temperature entry becomes humidity after the first build.
    // The still eligible source should keep its child and number.
    const seeded = sensors("sensor.temperature_2");
    const reordered = sut(
      seeded,
      { autoComposedDevices: true },
      temperatureOnly(),
    );
    expect(
      reordered.composedTemperatureCompanions("sensor.temperature")
        ?.humidityEntityId,
    ).toBe("sensor.humidity");
    seeded["sensor.temperature_2"] = state("sensor.temperature_2", "55", {
      device_class: SensorDeviceClass.humidity,
    });
    refreshWith(reordered, {});
    expect(
      reordered.composedTemperatureCompanions("sensor.temperature")
        ?.humidityEntityId,
    ).toBe("sensor.humidity");
  });

  it("gives an explicitly composed source priority over an earlier automatic match", () => {
    const registry = sut(
      sensors("sensor.temperature_2"),
      { autoComposedDevices: true },
      temperatureOnly(["sensor.humidity"]),
    );
    refreshWith(registry, {
      "sensor.temperature_2": { humidityEntity: "sensor.humidity" },
      "sensor.humidity": { disabled: true },
    });
    expect(
      registry.composedTemperatureCompanions("sensor.temperature"),
    ).toEqual({
      pressureEntityId: "sensor.pressure",
    });
    expect(
      registry.composedTemperatureCompanions("sensor.temperature_2"),
    ).toEqual({
      humidityEntityId: "sensor.humidity",
    });
    expect(registry.isComposedSubEntityUsed("sensor.humidity")).toBe(true);
    expect(registry.entityIds).toEqual([
      "sensor.temperature",
      "sensor.temperature_2",
    ]);
  });

  it("forgets the composed child when composition and auto mapping are off", () => {
    const flags: Record<string, boolean> = {
      autoComposedDevices: true,
      autoHumidityMapping: false,
      autoPressureMapping: false,
    };
    const registry = sut(sensors(), flags, temperatureOnly());
    expect(
      registry.composedTemperatureCompanions("sensor.temperature"),
    ).toBeDefined();
    flags.autoComposedDevices = false;
    refreshWith(registry, {});
    expect(registry.entityIds).toEqual(["sensor.temperature"]);
  });

  it("names a mapped source it cannot use once, and not while it has no state", () => {
    const warnings: string[] = [];
    const stop = diagnosticEventBus.subscribe((event) => {
      if (event.type === "entity_warning") warnings.push(event.message);
    });
    try {
      const states = {
        ...sensors(),
        "sensor.template": state("sensor.template", "unavailable", {}),
      };
      const registry = sut(states, {}, temperatureOnly());
      const mappings = {
        "sensor.temperature": {
          humidityEntity: "sensor.humidity",
          pressureEntity: "sensor.template",
        },
        "sensor.humidity": { disabled: true },
      };
      refreshWith(registry, mappings);
      refreshWith(registry, mappings);
      expect(registry.entityIds).toEqual(["sensor.temperature"]);
      expect(warnings).toEqual([expect.stringContaining("sensor.humidity")]);

      states["sensor.template"] = state("sensor.template", "5", {});
      refreshWith(registry, mappings);
      expect(warnings).toEqual([
        expect.stringContaining("sensor.humidity"),
        expect.stringContaining("sensor.template"),
      ]);
    } finally {
      stop();
    }
  });

  it("names an automatic sibling that a setting keeps out", () => {
    const warnings: string[] = [];
    const stop = diagnosticEventBus.subscribe((event) => {
      if (event.type === "entity_warning") warnings.push(event.message);
    });
    try {
      const registry = sut(sensors(), {}, temperatureOnly());
      const mappings = { "sensor.humidity": { disabled: true } };
      refreshWith(registry, mappings);
      refreshWith(registry, mappings);
      expect(registry.entityIds).toEqual([
        "sensor.temperature",
        "sensor.pressure",
      ]);
      expect(warnings).toEqual([
        expect.stringMatching(/sensor\.humidity.*Auto Humidity Mapping/),
      ]);
    } finally {
      stop();
    }
  });
});

describe("BridgeRegistry battery pre-calculation", () => {
  const door = () => ({
    "binary_sensor.door": state("binary_sensor.door", "off", {
      device_class: "door",
    }),
    "sensor.door_battery": state("sensor.door_battery", "80", {
      device_class: SensorDeviceClass.battery,
    }),
  });
  const auto = { autoBatteryMapping: true };

  it("claims the device battery for the main entity", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {});
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });

  it("claims nothing for a disabled main entity", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, { "binary_sensor.door": { disabled: true } });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(false);
  });

  it("keeps a battery hidden when the main entity opts out of it", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { disableBatteryMapping: true },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });

  it("leaves the device battery standalone when the mapping names another", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { batteryEntity: "sensor.other_battery" },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(false);
  });

  it("still claims the battery the mapping names explicitly", () => {
    const registry = sut(door(), auto);
    refreshWith(registry, {
      "binary_sensor.door": { batteryEntity: "sensor.door_battery" },
    });
    expect(registry.isBatteryEntityUsed("sensor.door_battery")).toBe(true);
  });
});

describe("BridgeRegistry filter budget", () => {
  it("throws on a slow pattern and keeps the last entity list", () => {
    const id = `sensor.${"a".repeat(43)}`;
    const registry = sut(sensors(id), { autoComposedDevices: true });
    refreshWith(registry, {});
    const before = registry.entityIds;
    const filter = (
      registry as unknown as {
        dataProvider: { filter: { include: unknown[] } };
      }
    ).dataProvider.filter;
    filter.include = [{ type: "regex", value: "(.*)*x" }];

    const started = Date.now();
    expect(() => refreshWith(registry, {})).toThrow(FilterTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(registry.entityIds).toEqual(before);
    expect(registry.isComposedSubEntityUsed("sensor.humidity")).toBe(true);
  });
});
