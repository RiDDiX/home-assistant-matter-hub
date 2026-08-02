import {
  type BinarySensorDeviceAttributes,
  BinarySensorDeviceClass,
  type ClimateDeviceAttributes,
  ClimateHvacAction,
  ClimateHvacMode,
  ClusterId,
  type CoverDeviceAttributes,
  type FanDeviceAttributes,
  HomeAssistantDomain,
  type HomeAssistantEntityInformation,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  type HumidiferDeviceAttributes,
  type LawnMowerDeviceAttributes,
  type LightDeviceAttributes,
  LightDeviceColorMode,
  MediaPlayerDeviceFeature,
  type SensorDeviceAttributes,
  SensorDeviceClass,
  type VacuumDeviceAttributes,
  type WaterHeaterDeviceAttributes,
  type WeatherEntityAttributes,
} from "@home-assistant-matter-hub/common";
import { Endpoint, type EndpointType } from "@matter/main";
import { uniq } from "lodash-es";
import { describe, expect, it } from "vitest";
import { createLegacyEndpointType } from "./create-legacy-endpoint-type.js";

const testEntities: Record<
  HomeAssistantDomain,
  HomeAssistantEntityInformation[]
> = {
  [HomeAssistantDomain.binary_sensor]: Object.values(
    BinarySensorDeviceClass,
  ).map((device_class, idx) =>
    createEntity<BinarySensorDeviceAttributes>(
      `binary_sensor.bs${idx + 1}`,
      "on",
      {
        device_class: device_class,
      },
    ),
  ),
  [HomeAssistantDomain.vacuum]: [
    createEntity<VacuumDeviceAttributes>("vacuum.vac1", "cleaning", {
      supported_features: 15, // Simulating support for various vacuum features
      battery_level: 75,
      fan_speed: "medium",
      fan_speed_list: ["off", "low", "medium", "high"],
    }),
  ],
  [HomeAssistantDomain.climate]: [
    createEntity<ClimateDeviceAttributes>("climate.cl1", "on", {
      hvac_modes: [ClimateHvacMode.heat],
      hvac_mode: ClimateHvacMode.off,
      hvac_action: ClimateHvacAction.off,
    }),
    createEntity<ClimateDeviceAttributes>("climate.cl2", "on", {
      hvac_modes: [ClimateHvacMode.cool],
      hvac_mode: ClimateHvacMode.off,
      hvac_action: ClimateHvacAction.off,
    }),
    createEntity<ClimateDeviceAttributes>("climate.cl3", "on", {
      hvac_modes: [ClimateHvacMode.heat_cool],
      hvac_mode: ClimateHvacMode.off,
      hvac_action: ClimateHvacAction.off,
    }),
    createEntity<ClimateDeviceAttributes>("climate.cl4", "on", {
      hvac_modes: [ClimateHvacMode.heat, ClimateHvacMode.cool],
      hvac_mode: ClimateHvacMode.off,
      hvac_action: ClimateHvacAction.off,
    }),
    // Ventilation-only device (e.g. Ambientika CMV, #130)
    createEntity<ClimateDeviceAttributes>("climate.cl5", "on", {
      hvac_modes: [ClimateHvacMode.fan_only, ClimateHvacMode.off],
      hvac_mode: ClimateHvacMode.off,
      hvac_action: ClimateHvacAction.off,
    }),
  ],
  [HomeAssistantDomain.cover]: [
    createEntity<CoverDeviceAttributes>("cover.co1", "on", {
      supported_features: 15,
    }),
  ],
  [HomeAssistantDomain.fan]: [
    createEntity<FanDeviceAttributes>("fan.f1", "on"),
    createEntity<FanDeviceAttributes>("fan.f2", "on", {
      supported_features: 1, // SET_SPEED
      percentage: 50,
      percentage_step: 33.33,
    }),
  ],
  [HomeAssistantDomain.light]: [
    createEntity<LightDeviceAttributes>("light.l1", "on"),
    createEntity<LightDeviceAttributes>("light.l2", "on", {
      supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
    }),
    createEntity<LightDeviceAttributes>("light.l3", "on", {
      supported_color_modes: [
        LightDeviceColorMode.BRIGHTNESS,
        LightDeviceColorMode.HS,
      ],
    }),
    createEntity<LightDeviceAttributes>("light.l4", "on", {
      supported_color_modes: [
        LightDeviceColorMode.BRIGHTNESS,
        LightDeviceColorMode.COLOR_TEMP,
      ],
    }),
    createEntity<LightDeviceAttributes>("light.l5", "on", {
      supported_color_modes: [
        LightDeviceColorMode.BRIGHTNESS,
        LightDeviceColorMode.HS,
        LightDeviceColorMode.COLOR_TEMP,
      ],
    }),
  ],
  [HomeAssistantDomain.lock]: [
    createEntity("lock.l1", "locked"),
    // Lock with OPEN feature (unlatch/unbolt support)
    createEntity("lock.l2", "locked", { supported_features: 1 }),
  ],
  [HomeAssistantDomain.sensor]: [
    createEntity<SensorDeviceAttributes>("sensor.s1", "20", {
      device_class: SensorDeviceClass.temperature,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s2", "50", {
      device_class: SensorDeviceClass.humidity,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s3", "100", {
      device_class: SensorDeviceClass.illuminance,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s4", "1013", {
      device_class: SensorDeviceClass.pressure,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s5", "1.5", {
      device_class: SensorDeviceClass.volume_flow_rate,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s6", "50", {
      device_class: SensorDeviceClass.aqi,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s7", "400", {
      device_class: SensorDeviceClass.carbon_dioxide,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s8", "5", {
      device_class: SensorDeviceClass.carbon_monoxide,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s9", "40", {
      device_class: SensorDeviceClass.nitrogen_dioxide,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s10", "60", {
      device_class: SensorDeviceClass.ozone,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s11", "15", {
      device_class: SensorDeviceClass.pm1,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s12", "25", {
      device_class: SensorDeviceClass.pm25,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s13", "50", {
      device_class: SensorDeviceClass.pm10,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s14", "100", {
      device_class: SensorDeviceClass.volatile_organic_compounds,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s15", "1500", {
      device_class: SensorDeviceClass.power,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s16", "12.5", {
      device_class: SensorDeviceClass.energy,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s17", "230", {
      device_class: SensorDeviceClass.voltage,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s18", "6.5", {
      device_class: SensorDeviceClass.current,
    }),
    createEntity<SensorDeviceAttributes>("sensor.s19", "75", {
      device_class: SensorDeviceClass.battery,
    }),
  ],
  [HomeAssistantDomain.switch]: [createEntity("switch.sw1", "on")],
  [HomeAssistantDomain.automation]: [
    createEntity("automation.automation1", "on"),
  ],
  [HomeAssistantDomain.script]: [createEntity("script.script1", "on")],
  [HomeAssistantDomain.scene]: [createEntity("scene.scene1", "on")],
  [HomeAssistantDomain.input_boolean]: [
    createEntity("input_boolean.input_boolean1", "on"),
  ],
  [HomeAssistantDomain.input_button]: [createEntity("input_button.ib1", "any")],
  [HomeAssistantDomain.button]: [createEntity("button.b1", "any")],
  [HomeAssistantDomain.media_player]: [
    createEntity("media_player.m1", "on", {
      supported_features: MediaPlayerDeviceFeature.SELECT_SOURCE,
    }),
  ],
  [HomeAssistantDomain.humidifier]: [
    createEntity<HumidiferDeviceAttributes>("humidifier.h1", "on", {
      min_humidity: 15,
      max_humidity: 80,
      humidity: 60,
      current_humidity: 45,
    }),
  ],
  [HomeAssistantDomain.event]: [
    createEntity("event.doorbell_press", "2024-01-01T00:00:00", {
      device_class: "doorbell",
      event_types: ["press", "double_press"],
      event_type: "press",
    }),
  ],
  [HomeAssistantDomain.lawn_mower]: [
    createEntity<LawnMowerDeviceAttributes>("lawn_mower.lm1", "docked", {
      supported_features: 7, // START_MOWING + PAUSE + DOCK
      battery_level: 80,
    }),
  ],
  [HomeAssistantDomain.valve]: [createEntity("valve.v1", "open")],
  [HomeAssistantDomain.alarm_control_panel]: [
    createEntity("alarm_control_panel.a1", "armed_away", {
      supported_features: 3, // ARM_HOME + ARM_AWAY
    }),
  ],
  [HomeAssistantDomain.remote]: [createEntity("remote.r1", "on")],
  [HomeAssistantDomain.siren]: [createEntity("siren.s1", "off")],
  [HomeAssistantDomain.select]: [
    createEntity("select.mode1", "option_a", {
      options: ["option_a", "option_b", "option_c"],
    }),
  ],
  [HomeAssistantDomain.input_select]: [
    createEntity("input_select.is1", "choice_1", {
      options: ["choice_1", "choice_2", "choice_3"],
    }),
  ],
  [HomeAssistantDomain.water_heater]: [
    createEntity<WaterHeaterDeviceAttributes>("water_heater.wh1", "off", {
      min_temp: 30,
      max_temp: 100,
      current_temperature: 45,
      temperature: 60,
      operation_mode: "off",
      operation_list: ["off", "eco", "electric"],
    }),
  ],
  [HomeAssistantDomain.weather]: [
    createEntity<WeatherEntityAttributes>("weather.home", "sunny", {
      temperature: 21,
      temperature_unit: "°C",
      humidity: 55,
      pressure: 1013,
      pressure_unit: "hPa",
    }),
  ],
};

describe("createLegacyEndpointType", () => {
  it("should not use any unknown clusterId", () => {
    const entities = Object.values(testEntities).flat();
    const devices = entities.map((entity) => createLegacyEndpointType(entity));
    // A mapped battery upgrades to the BatteryStorage ESS type, a second
    // powerTopology mount alongside the meter default.
    devices.push(
      createLegacyEndpointType(
        createEntity<SensorDeviceAttributes>("sensor.batt_ess", "80", {
          device_class: SensorDeviceClass.battery,
        }),
        {
          entityId: "sensor.batt_ess",
          batteryPowerEntity: "sensor.batt_power",
        },
      ),
    );
    const endpoints = devices
      .filter((d): d is EndpointType => d != null)
      .map((endpointType) => new Endpoint(endpointType));
    const actual = uniq(endpoints.flatMap((d) => Object.keys(d.state)))
      .filter((key) => !/^\d+$/.test(key))
      .sort();
    // fanSpeedMemory stays out of ClusterId on purpose: CustomStorage skips
    // loading ClusterId-suffixed contexts, and the speed memory must persist.
    const expected = [...Object.keys(ClusterId), "fanSpeedMemory"].sort();
    expect(actual).toEqual(expected);
  });
});

describe("explicit matterDeviceType battery (#408)", () => {
  const entity = createEntity<BinarySensorDeviceAttributes>(
    "binary_sensor.occ",
    "on",
    { device_class: BinarySensorDeviceClass.Occupancy },
  );

  it("adds a power source when a battery entity is mapped", () => {
    const type = createLegacyEndpointType(entity, {
      entityId: "binary_sensor.occ",
      matterDeviceType: "occupancy_sensor",
      batteryEntity: "sensor.battery",
    });
    expect(type).toBeDefined();
    expect(type!.behaviors).toHaveProperty("powerSource");
  });

  it("has no power source without a battery entity", () => {
    const type = createLegacyEndpointType(entity, {
      entityId: "binary_sensor.occ",
      matterDeviceType: "occupancy_sensor",
    });
    expect(type).toBeDefined();
    expect(type!.behaviors).not.toHaveProperty("powerSource");
  });
});

function createEntity<T extends {} = {}>(
  entityId: string,
  state: string,
  attributes?: T,
): HomeAssistantEntityInformation {
  const registry: HomeAssistantEntityRegistry = {
    device_id: `${entityId}_device`,
    categories: {},
    entity_id: entityId,
    has_entity_name: false,
    id: entityId,
    original_name: entityId,
    platform: "test",
    unique_id: entityId,
  };
  const entityState: HomeAssistantEntityState = {
    entity_id: entityId,
    state,
    context: { id: "context" },
    last_changed: "any-change",
    last_updated: "any-update",
    attributes: attributes ?? {},
  };
  return { entity_id: entityId, registry, state: entityState };
}
