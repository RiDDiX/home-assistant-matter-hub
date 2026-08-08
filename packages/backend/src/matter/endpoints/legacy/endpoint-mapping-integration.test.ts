import {
  type BinarySensorDeviceAttributes,
  BinarySensorDeviceClass,
  type ClimateDeviceAttributes,
  ClimateDeviceFeature,
  ClimateHvacAction,
  ClimateHvacMode,
  type CoverDeviceAttributes,
  type EntityMappingConfig,
  type FanDeviceAttributes,
  FanDeviceFeature,
  type HomeAssistantEntityInformation,
  type HomeAssistantEntityRegistry,
  type HomeAssistantEntityState,
  type HumidiferDeviceAttributes,
  type LightDeviceAttributes,
  LightDeviceColorMode,
  type MatterDeviceType,
  type MediaPlayerDeviceAttributes,
  MediaPlayerDeviceClass,
  MediaPlayerDeviceFeature,
  type SensorDeviceAttributes,
  SensorDeviceClass,
  type VacuumDeviceAttributes,
  type WaterHeaterDeviceAttributes,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { validateEndpointType } from "../validate-endpoint-type.js";
import { createLegacyEndpointType } from "./create-legacy-endpoint-type.js";

function createEntity<T extends object = Record<string, never>>(
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
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
    attributes: attributes ?? {},
  };
  return { entity_id: entityId, registry, state: entityState };
}

function createAndValidate(
  entity: HomeAssistantEntityInformation,
  mapping?: EntityMappingConfig,
) {
  const type = createLegacyEndpointType(entity, mapping);
  expect(type).toBeDefined();
  if (!type) {
    throw new Error(`Expected endpoint type for ${entity.entity_id}`);
  }
  const result = validateEndpointType(type, entity.entity_id);
  return { type, result };
}

describe("endpoint mapping integration", () => {
  describe("every domain produces a valid endpoint with no missing mandatory clusters", () => {
    const domainEntities: [string, HomeAssistantEntityInformation][] = [
      ["light (on/off)", createEntity("light.l1", "on")],
      [
        "light (dimmable)",
        createEntity<LightDeviceAttributes>("light.l2", "on", {
          supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
        }),
      ],
      [
        "light (color temp)",
        createEntity<LightDeviceAttributes>("light.l3", "on", {
          supported_color_modes: [
            LightDeviceColorMode.BRIGHTNESS,
            LightDeviceColorMode.COLOR_TEMP,
          ],
        }),
      ],
      [
        "light (extended color)",
        createEntity<LightDeviceAttributes>("light.l4", "on", {
          supported_color_modes: [
            LightDeviceColorMode.BRIGHTNESS,
            LightDeviceColorMode.HS,
            LightDeviceColorMode.COLOR_TEMP,
          ],
        }),
      ],
      ["switch", createEntity("switch.sw1", "on")],
      ["lock", createEntity("lock.lk1", "locked")],
      [
        "fan",
        createEntity<FanDeviceAttributes>("fan.f1", "on", {
          supported_features: 1,
          percentage: 50,
          percentage_step: 33.33,
        }),
      ],
      [
        "binary_sensor (contact)",
        createEntity<BinarySensorDeviceAttributes>("binary_sensor.bs1", "on", {
          device_class: BinarySensorDeviceClass.Door,
        }),
      ],
      [
        "binary_sensor (occupancy)",
        createEntity<BinarySensorDeviceAttributes>("binary_sensor.bs2", "on", {
          device_class: BinarySensorDeviceClass.Motion,
        }),
      ],
      [
        "sensor (temperature)",
        createEntity<SensorDeviceAttributes>("sensor.temp1", "22.5", {
          device_class: SensorDeviceClass.temperature,
        }),
      ],
      [
        "sensor (humidity)",
        createEntity<SensorDeviceAttributes>("sensor.hum1", "55", {
          device_class: SensorDeviceClass.humidity,
        }),
      ],
      [
        "sensor (pressure)",
        createEntity<SensorDeviceAttributes>("sensor.pres1", "1013", {
          device_class: SensorDeviceClass.pressure,
        }),
      ],
      [
        "sensor (illuminance)",
        createEntity<SensorDeviceAttributes>("sensor.lux1", "800", {
          device_class: SensorDeviceClass.illuminance,
        }),
      ],
      [
        "sensor (battery)",
        createEntity<SensorDeviceAttributes>("sensor.bat1", "85", {
          device_class: SensorDeviceClass.battery,
        }),
      ],
      [
        "sensor (air quality)",
        createEntity<SensorDeviceAttributes>("sensor.aqi1", "42", {
          device_class: SensorDeviceClass.aqi,
        }),
      ],
      [
        "sensor (co)",
        createEntity<SensorDeviceAttributes>("sensor.co1", "5", {
          device_class: SensorDeviceClass.carbon_monoxide,
        }),
      ],
      [
        "sensor (no2)",
        createEntity<SensorDeviceAttributes>("sensor.no2_1", "30", {
          device_class: SensorDeviceClass.nitrogen_dioxide,
        }),
      ],
      [
        "sensor (ozone)",
        createEntity<SensorDeviceAttributes>("sensor.oz1", "40", {
          device_class: SensorDeviceClass.ozone,
        }),
      ],
      [
        "sensor (pm1)",
        createEntity<SensorDeviceAttributes>("sensor.pm1_1", "10", {
          device_class: SensorDeviceClass.pm1,
        }),
      ],
      [
        "sensor (tvoc)",
        createEntity<SensorDeviceAttributes>("sensor.tvoc1", "200", {
          device_class: SensorDeviceClass.volatile_organic_compounds,
        }),
      ],
      [
        "sensor (formaldehyde)",
        createEntity<SensorDeviceAttributes>("sensor.hcho1", "0.02", {
          device_class: SensorDeviceClass.volatile_organic_compounds_parts,
        }),
      ],
      [
        "sensor (flow)",
        createEntity<SensorDeviceAttributes>("sensor.flow1", "2.5", {
          device_class: SensorDeviceClass.volume_flow_rate,
        }),
      ],
      [
        "sensor (power)",
        createEntity<SensorDeviceAttributes>("sensor.pow1", "1500", {
          device_class: SensorDeviceClass.power,
        }),
      ],
      [
        "sensor (energy)",
        createEntity<SensorDeviceAttributes>("sensor.en1", "12.5", {
          device_class: SensorDeviceClass.energy,
        }),
      ],
      [
        "cover",
        createEntity<CoverDeviceAttributes>("cover.co1", "open", {
          supported_features: 15,
        }),
      ],
      [
        "climate (heat)",
        createEntity<ClimateDeviceAttributes>("climate.cl1", "heat", {
          hvac_modes: [ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.heat,
          hvac_action: ClimateHvacAction.heating,
        }),
      ],
      [
        "climate (cool)",
        createEntity<ClimateDeviceAttributes>("climate.cl2", "cool", {
          hvac_modes: [ClimateHvacMode.cool],
          hvac_mode: ClimateHvacMode.cool,
          hvac_action: ClimateHvacAction.cooling,
        }),
      ],
      [
        "climate (heat_cool)",
        createEntity<ClimateDeviceAttributes>("climate.cl3", "auto", {
          hvac_modes: [ClimateHvacMode.heat_cool],
          hvac_mode: ClimateHvacMode.heat_cool,
          hvac_action: ClimateHvacAction.idle,
        }),
      ],
      [
        "climate (auto+heat+cool)",
        createEntity<ClimateDeviceAttributes>("climate.cl4", "auto", {
          hvac_modes: [
            ClimateHvacMode.auto,
            ClimateHvacMode.heat,
            ClimateHvacMode.cool,
            ClimateHvacMode.off,
          ],
          hvac_mode: ClimateHvacMode.auto,
          hvac_action: ClimateHvacAction.cooling,
        }),
      ],
      ["automation", createEntity("automation.auto1", "on")],
      ["script", createEntity("script.scr1", "off")],
      ["scene", createEntity("scene.sc1", "on")],
      ["input_boolean", createEntity("input_boolean.ib1", "on")],
      ["input_button", createEntity("input_button.ibtn1", "any")],
      ["button", createEntity("button.btn1", "any")],
      [
        "media_player",
        createEntity("media_player.mp1", "playing", {
          supported_features: MediaPlayerDeviceFeature.SELECT_SOURCE,
        }),
      ],
      [
        "humidifier",
        createEntity<HumidiferDeviceAttributes>("humidifier.hm1", "on", {
          min_humidity: 15,
          max_humidity: 80,
          humidity: 60,
          current_humidity: 45,
        }),
      ],
      [
        "vacuum",
        createEntity<VacuumDeviceAttributes>("vacuum.vac1", "cleaning", {
          supported_features: 15,
          battery_level: 80,
          fan_speed: "medium",
          fan_speed_list: ["off", "low", "medium", "high"],
        }),
      ],
      ["valve", createEntity("valve.vlv1", "open")],
      [
        "alarm_control_panel",
        createEntity("alarm_control_panel.alm1", "armed_away", {
          supported_features: 3,
        }),
      ],
      ["remote", createEntity("remote.rm1", "on")],
      [
        "select",
        createEntity("select.sel1", "opt_a", {
          options: ["opt_a", "opt_b", "opt_c"],
        }),
      ],
      [
        "input_select",
        createEntity("input_select.is1", "ch_1", {
          options: ["ch_1", "ch_2", "ch_3"],
        }),
      ],
      [
        "event",
        createEntity("event.doorbell1", "2026-01-01T00:00:00", {
          device_class: "doorbell",
          event_types: ["press"],
          event_type: "press",
        }),
      ],
      [
        "water_heater",
        createEntity<WaterHeaterDeviceAttributes>("water_heater.wh1", "off", {
          min_temp: 30,
          max_temp: 100,
          current_temperature: 45,
          temperature: 60,
          operation_mode: "off",
          operation_list: ["off", "eco", "electric"],
        }),
      ],
    ];

    it.each(
      domainEntities,
    )("%s → no missing mandatory clusters", (_label, entity) => {
      const { result } = createAndValidate(entity);
      expect(result).toBeDefined();
      if (!result) {
        throw new Error(`Expected validation result for ${entity.entity_id}`);
      }
      expect(result.missingMandatory).toEqual([]);
    });
  });

  describe("device type overrides produce valid endpoints", () => {
    const overrides: [
      string,
      HomeAssistantEntityInformation,
      MatterDeviceType,
    ][] = [
      [
        "light → on_off_light",
        createEntity("light.ovr1", "on"),
        "on_off_light",
      ],
      [
        "light → dimmable_light",
        createEntity<LightDeviceAttributes>("light.ovr2", "on", {
          supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
        }),
        "dimmable_light",
      ],
      [
        "switch → on_off_plugin_unit",
        createEntity("switch.ovr3", "on"),
        "on_off_plugin_unit",
      ],
      [
        "switch → on_off_switch",
        createEntity("switch.ovr4", "on"),
        "on_off_switch",
      ],
      [
        "climate → thermostat",
        createEntity<ClimateDeviceAttributes>("climate.ovr5", "heat", {
          hvac_modes: [ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.heat,
          hvac_action: ClimateHvacAction.heating,
        }),
        "thermostat",
      ],
      [
        "cover → window_covering",
        createEntity<CoverDeviceAttributes>("cover.ovr6", "open", {
          supported_features: 15,
        }),
        "window_covering",
      ],
      [
        "sensor → temperature_sensor",
        createEntity<SensorDeviceAttributes>("sensor.ovr7", "20", {
          device_class: SensorDeviceClass.temperature,
        }),
        "temperature_sensor",
      ],
      [
        "sensor → humidity_sensor",
        createEntity<SensorDeviceAttributes>("sensor.ovr8", "50", {
          device_class: SensorDeviceClass.humidity,
        }),
        "humidity_sensor",
      ],
      [
        "binary_sensor → contact_sensor",
        createEntity<BinarySensorDeviceAttributes>("binary_sensor.ovr9", "on", {
          device_class: BinarySensorDeviceClass.Door,
        }),
        "contact_sensor",
      ],
      [
        "binary_sensor → occupancy_sensor",
        createEntity<BinarySensorDeviceAttributes>(
          "binary_sensor.ovr10",
          "on",
          { device_class: BinarySensorDeviceClass.Occupancy },
        ),
        "occupancy_sensor",
      ],
      [
        "binary_sensor → motion_sensor",
        createEntity<BinarySensorDeviceAttributes>(
          "binary_sensor.ovr10b",
          "on",
          { device_class: BinarySensorDeviceClass.Motion },
        ),
        "motion_sensor",
      ],
      [
        "switch → water_valve",
        createEntity("switch.ovr11", "on"),
        "water_valve",
      ],
      ["switch → pump", createEntity("switch.ovr12", "on"), "pump"],
      ["lock → door_lock", createEntity("lock.ovr13", "locked"), "door_lock"],
      [
        "event → generic_switch",
        createEntity("event.ovr14", "2026-01-01T00:00:00", {
          device_class: "doorbell",
          event_types: ["press"],
          event_type: "press",
        }),
        "generic_switch",
      ],
      [
        "media_player (tv) → speaker",
        createEntity<MediaPlayerDeviceAttributes>("media_player.ovr15", "off", {
          device_class: MediaPlayerDeviceClass.Tv,
          supported_features:
            MediaPlayerDeviceFeature.TURN_ON |
            MediaPlayerDeviceFeature.TURN_OFF |
            MediaPlayerDeviceFeature.VOLUME_SET,
        }),
        "speaker",
      ],
      [
        "media_player (tv) → basic_video_player",
        createEntity<MediaPlayerDeviceAttributes>("media_player.ovr16", "off", {
          device_class: MediaPlayerDeviceClass.Tv,
          supported_features:
            MediaPlayerDeviceFeature.TURN_ON |
            MediaPlayerDeviceFeature.TURN_OFF,
        }),
        "basic_video_player",
      ],
    ];

    it.each(
      overrides,
    )("%s → no missing mandatory clusters", (_label, entity, deviceType) => {
      const { result } = createAndValidate(entity, {
        entityId: entity.entity_id,
        matterDeviceType: deviceType,
      });
      expect(result).toBeDefined();
      if (!result) {
        throw new Error(`Expected validation result for ${entity.entity_id}`);
      }
      expect(result.missingMandatory).toEqual([]);
    });
  });

  describe("expected behaviors are present per domain", () => {
    it("light entities have onOff behavior", () => {
      const entity = createEntity("light.beh1", "on");
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("onOff");
    });

    it("dimmable light has levelControl behavior", () => {
      const entity = createEntity<LightDeviceAttributes>("light.beh2", "on", {
        supported_color_modes: [LightDeviceColorMode.BRIGHTNESS],
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("onOff");
      expect(type.behaviors).toHaveProperty("levelControl");
    });

    it("extended color light has colorControl behavior", () => {
      const entity = createEntity<LightDeviceAttributes>("light.beh3", "on", {
        supported_color_modes: [
          LightDeviceColorMode.BRIGHTNESS,
          LightDeviceColorMode.HS,
          LightDeviceColorMode.COLOR_TEMP,
        ],
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("onOff");
      expect(type.behaviors).toHaveProperty("levelControl");
      expect(type.behaviors).toHaveProperty("colorControl");
    });

    it("climate has thermostat behavior", () => {
      const entity = createEntity<ClimateDeviceAttributes>(
        "climate.beh4",
        "heat",
        {
          hvac_modes: [ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.heat,
          hvac_action: ClimateHvacAction.heating,
        },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("thermostat");
    });

    it("climate with TURN_ON/TURN_OFF gets onOff behavior by default", () => {
      const entity = createEntity<ClimateDeviceAttributes>(
        "climate.beh4a",
        "heat",
        {
          hvac_modes: [ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.heat,
          hvac_action: ClimateHvacAction.heating,
          supported_features:
            ClimateDeviceFeature.TURN_ON | ClimateDeviceFeature.TURN_OFF,
        },
      );
      const type = createLegacyEndpointType(entity);
      expect(type?.behaviors).toHaveProperty("onOff");
    });

    it("climate omits onOff when disableClimateOnOff mapping is set", () => {
      const entity = createEntity<ClimateDeviceAttributes>(
        "climate.beh4b",
        "heat",
        {
          hvac_modes: [ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.heat,
          hvac_action: ClimateHvacAction.heating,
          supported_features:
            ClimateDeviceFeature.TURN_ON | ClimateDeviceFeature.TURN_OFF,
        },
      );
      const type = createLegacyEndpointType(entity, {
        entityId: entity.entity_id,
        disableClimateOnOff: true,
      });
      expect(type?.behaviors).toHaveProperty("thermostat");
      expect(type?.behaviors).not.toHaveProperty("onOff");
    });

    it("climate omits fanControl when disableClimateFanControl mapping is set", () => {
      const entity = createEntity<ClimateDeviceAttributes>(
        "climate.beh4c",
        "cool",
        {
          hvac_modes: [ClimateHvacMode.cool, ClimateHvacMode.heat],
          hvac_mode: ClimateHvacMode.cool,
          hvac_action: ClimateHvacAction.cooling,
          fan_modes: ["low", "high"],
          fan_mode: "low",
          supported_features:
            ClimateDeviceFeature.TURN_ON |
            ClimateDeviceFeature.TURN_OFF |
            ClimateDeviceFeature.FAN_MODE,
        },
      );
      const baseType = createLegacyEndpointType(entity);
      expect(baseType?.behaviors).toHaveProperty("fanControl");

      const overrideType = createLegacyEndpointType(entity, {
        entityId: entity.entity_id,
        disableClimateFanControl: true,
      });
      expect(overrideType?.behaviors).toHaveProperty("thermostat");
      expect(overrideType?.behaviors).not.toHaveProperty("fanControl");
    });

    it("climate accepts climateAutoMode override for single-setpoint auto ACs", () => {
      const entity = createEntity<ClimateDeviceAttributes>(
        "climate.beh4d",
        ClimateHvacMode.auto,
        {
          hvac_modes: [
            ClimateHvacMode.auto,
            ClimateHvacMode.heat,
            ClimateHvacMode.cool,
            ClimateHvacMode.off,
          ],
          hvac_mode: ClimateHvacMode.auto,
          hvac_action: ClimateHvacAction.idle,
          supported_features:
            ClimateDeviceFeature.TARGET_TEMPERATURE |
            ClimateDeviceFeature.TURN_ON |
            ClimateDeviceFeature.TURN_OFF,
          temperature: 24,
          current_temperature: 27,
        },
      );
      const type = createLegacyEndpointType(entity, {
        entityId: entity.entity_id,
        climateAutoMode: "cool",
      });
      expect(type?.behaviors).toHaveProperty("thermostat");
    });

    it("cover has windowCovering behavior", () => {
      const entity = createEntity<CoverDeviceAttributes>("cover.beh5", "open", {
        supported_features: 15,
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("windowCovering");
    });

    it("cover exposes as a dimmable light when the #372 flag is set", () => {
      const entity = createEntity<CoverDeviceAttributes>(
        "cover.alexa",
        "open",
        {
          supported_features: 15,
        },
      );
      const type = createLegacyEndpointType(entity, {
        entityId: entity.entity_id,
        coverExposeAsDimmableLight: true,
      });
      expect(type?.behaviors).toHaveProperty("onOff");
      expect(type?.behaviors).toHaveProperty("levelControl");
      expect(type?.behaviors).not.toHaveProperty("windowCovering");
    });

    it("garage cover has windowCovering behavior (discrete mode)", () => {
      const entity = createEntity<
        CoverDeviceAttributes & { device_class: string }
      >("cover.garage1", "closed", {
        supported_features: 3,
        device_class: "garage",
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("windowCovering");
    });

    it("lock has doorLock behavior", () => {
      const entity = createEntity("lock.beh6", "locked");
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("doorLock");
    });

    it("fan has fanControl behavior", () => {
      const entity = createEntity<FanDeviceAttributes>("fan.beh7", "on", {
        supported_features: 1,
        percentage: 50,
        percentage_step: 33.33,
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("fanControl");
    });

    it("fan with DIRECTION bit exposes AirflowDirection feature (#272)", () => {
      const withDirection = createEntity<FanDeviceAttributes>(
        "fan.beh7_dir",
        "on",
        {
          supported_features:
            FanDeviceFeature.SET_SPEED | FanDeviceFeature.DIRECTION,
          percentage: 50,
          percentage_step: 33.33,
        },
      );
      const { type: typeWithDirection } = createAndValidate(withDirection);
      const fanControlWithDirection = (
        typeWithDirection.behaviors as Record<
          string,
          { features?: { airflowDirection?: boolean } }
        >
      ).fanControl;
      expect(fanControlWithDirection?.features?.airflowDirection).toBe(true);

      const withoutDirection = createEntity<FanDeviceAttributes>(
        "fan.beh7_nodir",
        "on",
        {
          supported_features: FanDeviceFeature.SET_SPEED,
          percentage: 50,
          percentage_step: 33.33,
        },
      );
      const { type: typeWithoutDirection } =
        createAndValidate(withoutDirection);
      const fanControlWithoutDirection = (
        typeWithoutDirection.behaviors as Record<
          string,
          { features?: { airflowDirection?: boolean } }
        >
      ).fanControl;
      expect(fanControlWithoutDirection?.features?.airflowDirection).toBe(
        false,
      );
    });

    it("temperature sensor has temperatureMeasurement behavior", () => {
      const entity = createEntity<SensorDeviceAttributes>("sensor.beh8", "22", {
        device_class: SensorDeviceClass.temperature,
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("temperatureMeasurement");
    });

    it("humidity sensor has relativeHumidityMeasurement behavior", () => {
      const entity = createEntity<SensorDeviceAttributes>("sensor.beh9", "55", {
        device_class: SensorDeviceClass.humidity,
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("relativeHumidityMeasurement");
    });

    it("moisture sensor is exposed as humidity sensor (#273)", () => {
      const entity = createEntity<SensorDeviceAttributes>(
        "sensor.beh9_moist",
        "42",
        { device_class: SensorDeviceClass.moisture },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("relativeHumidityMeasurement");
    });

    it("contact sensor has booleanState behavior", () => {
      const entity = createEntity<BinarySensorDeviceAttributes>(
        "binary_sensor.beh10",
        "on",
        { device_class: BinarySensorDeviceClass.Door },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("booleanState");
    });

    it("motion sensor has occupancySensing behavior (PIR)", () => {
      const entity = createEntity<BinarySensorDeviceAttributes>(
        "binary_sensor.beh11",
        "on",
        { device_class: BinarySensorDeviceClass.Motion },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("occupancySensing");
    });

    it("occupancy sensor has occupancySensing behavior (PhysicalContact)", () => {
      const entity = createEntity<BinarySensorDeviceAttributes>(
        "binary_sensor.beh11b",
        "on",
        { device_class: BinarySensorDeviceClass.Occupancy },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("occupancySensing");
    });

    it("vacuum has rvcRunMode and rvcOperationalState behaviors", () => {
      const entity = createEntity<VacuumDeviceAttributes>(
        "vacuum.beh12",
        "cleaning",
        {
          supported_features: 15,
          battery_level: 80,
          fan_speed: "medium",
          fan_speed_list: ["off", "low", "medium", "high"],
        },
      );
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("rvcRunMode");
      expect(type.behaviors).toHaveProperty("rvcOperationalState");
    });

    it("event produces generic switch with switch behavior", () => {
      const entity = createEntity("event.beh13", "2026-01-01T00:00:00", {
        device_class: "doorbell",
        event_types: ["press"],
        event_type: "press",
      });
      const { type } = createAndValidate(entity);
      expect(type.behaviors).toHaveProperty("switch");
    });
  });

  describe("unsupported entities return undefined", () => {
    it("unknown domain returns undefined", () => {
      const entity = createEntity("unknown_domain.x1", "on");
      const type = createLegacyEndpointType(entity);
      expect(type).toBeUndefined();
    });

    it("sensor without device_class returns undefined", () => {
      const entity = createEntity("sensor.noclass", "42");
      const type = createLegacyEndpointType(entity);
      expect(type).toBeUndefined();
    });
  });
});
