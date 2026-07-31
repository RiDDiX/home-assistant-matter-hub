# Mapping Blueprints

This page provides ready-to-use mapping examples for complex device setups. You can use these as reference when configuring entity mappings in the HAMH UI or when creating mapping profiles for import.

---

## Composed Temperature + Humidity + Pressure Sensor

Combines a temperature sensor with related humidity and pressure sensors into a single Matter composed device. Each sensor appears as a proper sub-device in Apple Home, Google Home, and Alexa.

**Requirements:** Enable the `autoComposedDevices` feature flag on the bridge.

```json
{
  "entityId": "sensor.living_room_temperature",
  "humidityEntity": "sensor.living_room_humidity",
  "pressureEntity": "sensor.living_room_pressure",
  "batteryEntity": "sensor.living_room_battery"
}
```

### With Power Monitoring

If your sensor hub also reports power consumption:

```json
{
  "entityId": "sensor.living_room_temperature",
  "humidityEntity": "sensor.living_room_humidity",
  "pressureEntity": "sensor.living_room_pressure",
  "batteryEntity": "sensor.living_room_battery",
  "powerEntity": "sensor.living_room_power",
  "energyEntity": "sensor.living_room_energy"
}
```

---

## Composed Sub-Entities

Group arbitrary Home Assistant entities under a single Matter device. Set `composedEntities` on the primary entity's mapping and each listed entity becomes a sub-device of the primary. The sub-entities are absorbed into the composed device and stop appearing as standalone Matter devices.

Unlike auto-mapping, which only pulls in humidity/pressure/battery/power sensors on the same HA device, this lets you pick any entities you want, and they do **not** need to match the bridge filter. You choose them from the full HA registry in the UI.

The device battery sensor (auto-mapped via `autoBatteryMapping` or an explicit `batteryEntity`) is attached to the composed device so controllers show its battery level. If an integration (e.g. Xiaomi Home) reports a bogus battery sensor on a mains-powered device, set `disableBatteryMapping` on that entity to stop the false low-battery warning.

**Requirements:** Enable the `autoComposedDevices` feature flag on the bridge. Each sub-entity may set a `matterDeviceType` to control how it is exposed.

Example, a Hue Motion sensor exposed as one device with occupancy, illuminance, and temperature sub-devices:

```json
{
  "entityId": "binary_sensor.hue_motion_occupancy",
  "composedEntities": [
    { "entityId": "sensor.hue_motion_illuminance", "matterDeviceType": "light_sensor" },
    { "entityId": "sensor.hue_motion_temperature", "matterDeviceType": "temperature_sensor" }
  ]
}
```

---

## Air Purifier with Sensors

Maps a fan entity as an air purifier with temperature, humidity, and HEPA filter monitoring.

**Requirements:** Enable the `autoComposedDevices` feature flag. Set `matterDeviceType` to `air_purifier`.

```json
{
  "entityId": "fan.air_purifier",
  "matterDeviceType": "air_purifier",
  "temperatureEntity": "sensor.air_purifier_temperature",
  "humidityEntity": "sensor.air_purifier_humidity",
  "filterLifeEntity": "sensor.air_purifier_filter_life",
  "powerEntity": "sensor.air_purifier_power",
  "energyEntity": "sensor.air_purifier_energy"
}
```

---

## Smart Plug with Energy Monitoring

A switch with real-time power and cumulative energy measurement.

```json
{
  "entityId": "switch.smart_plug",
  "powerEntity": "sensor.smart_plug_power",
  "energyEntity": "sensor.smart_plug_energy"
}
```

### With Voltage and Current

`voltageEntity` and `currentEntity` group a voltage and current sensor into the same ElectricalPowerMeasurement cluster as the power reading. Use plain Home Assistant sensors: volts (V) for `voltageEntity`, amps (A) for `currentEntity`.

```json
{
  "entityId": "switch.smart_plug",
  "powerEntity": "sensor.smart_plug_power",
  "energyEntity": "sensor.smart_plug_energy",
  "voltageEntity": "sensor.smart_plug_voltage",
  "currentEntity": "sensor.smart_plug_current"
}
```

---

## Dimmable Light with Energy Monitoring

```json
{
  "entityId": "light.kitchen_ceiling",
  "powerEntity": "sensor.kitchen_ceiling_power",
  "energyEntity": "sensor.kitchen_ceiling_energy"
}
```

---

## Home Battery Storage

A battery `sensor` (`device_class: battery`) is exposed as a Matter Battery Storage device once you add `batteryPowerEntity` and/or `batteryEnergyEntity`. A plain percent battery without these stays an ordinary battery sensor.

- `batteryPowerEntity`: a power sensor in watts (W). The value is signed: positive while the battery discharges, negative while it charges.
- `batteryEnergyEntity`: an energy sensor in kilowatt-hours (kWh) reporting lifetime throughput.

```json
{
  "entityId": "sensor.home_battery_level",
  "batteryPowerEntity": "sensor.home_battery_power",
  "batteryEnergyEntity": "sensor.home_battery_energy"
}
```

---

## EV Charger (EVSE)

Home Assistant has no charger convention, so an EVSE is mapped by hand. Set the Matter device type to **EV Charger (EVSE)** on the charger's **status** entity (a `sensor` or `switch` whose state reads like `charging`, `connected`, `not connected`, `error`, ...). The status keyword drives the Matter EnergyEvse state:

- `charging` -> plugged in and charging
- `connected` / `ready` / `awaiting` / `completed` / `paused` / `sleeping` -> plugged in, idle
- `not connected` / `disconnected` / `no vehicle` -> unplugged
- `error` / `fault` -> fault
- anything else (incl. `unknown` / `unavailable`) -> reported unknown, charging left disabled

Optional companion entities:

- `chargingSwitchEntity`: a `switch` that starts and stops charging. A controller's EnableCharging turns it on, Disable turns it off. If EnableCharging carries a "charging enabled until" time, that window is honored: an already-elapsed time is treated as Disable, and a future time arms a timer that turns the switch off when it expires.
- `currentLimitEntity`: a `number` entity in amperes for the charge current limit. EnableCharging writes the requested maximum here (clamped to the 6 to 32 A circuit capacity), and its live value feeds MaximumChargeCurrent (clamped the same way).
- `powerEntity` / `energyEntity`: the same power (W) and energy (kWh) sensors used elsewhere, folded onto the charger endpoint as real-time power and cumulative energy.

The endpoint also advertises the ElectricalSensor device type and a mains PowerSource. The Matter spec additionally lists a DeviceEnergyManagement device type, but Home Assistant exposes no charging forecast to feed it honestly, and the controllers tested so far render the EVSE without it, so it is left off.

```json
{
  "entityId": "sensor.wallbox_status",
  "matterDeviceType": "evse",
  "chargingSwitchEntity": "switch.wallbox_charging",
  "currentLimitEntity": "number.wallbox_current_limit",
  "powerEntity": "sensor.wallbox_power",
  "energyEntity": "sensor.wallbox_energy"
}
```

:::warning Keep EVSE off Alexa bridges
A bridged EVSE has been reported to break Alexa device recognition for the whole bridge. Home Assistant and Aqara Home render EnergyEvse; SmartThings announced support but it is unconfirmed. Only add an EVSE to a bridge that Alexa is not paired with.
:::

---

## Roborock Vacuum with Room Cleaning

Maps a vacuum with room-specific cleaning buttons and a cleaning mode selector.

```json
{
  "entityId": "vacuum.roborock_s7",
  "cleaningModeEntity": "select.roborock_s7_cleaning_mode",
  "suctionLevelEntity": "select.roborock_s7_suction_level",
  "mopIntensityEntity": "select.roborock_s7_mop_intensity",
  "roomEntities": [
    "button.roborock_s7_clean_kitchen",
    "button.roborock_s7_clean_living_room",
    "button.roborock_s7_clean_bedroom"
  ]
}
```

### Dreame Vacuum Variant

```json
{
  "entityId": "vacuum.dreame_l20",
  "cleaningModeEntity": "select.dreame_l20_cleaning_mode",
  "suctionLevelEntity": "select.dreame_l20_suction_level",
  "mopIntensityEntity": "select.dreame_l20_water_volume",
  "roomEntities": [
    "button.dreame_l20_clean_kitchen",
    "button.dreame_l20_clean_bathroom"
  ]
}
```

### Valetudo Vacuum

```json
{
  "entityId": "vacuum.valetudo_robot",
  "valetudoIdentifier": "valetudo_robot",
  "customServiceAreas": [
    { "areaId": 1, "label": "Kitchen" },
    { "areaId": 2, "label": "Living Room" }
  ]
}
```

---

## Door Lock with PIN Disabled

Useful when you have multiple locks and only want PIN protection on some.

```json
{
  "entityId": "lock.front_door",
  "disableLockPin": true
}
```

---

## Cover with Swapped Open/Close

For covers where Home Assistant reports inverted position values.

```json
{
  "entityId": "cover.garage_door",
  "coverSwapOpenClose": true
}
```

---

## Using Mapping Profiles

You can export and import mapping configurations as profiles via the HAMH UI or API:

1. **Export:** Go to Bridge Settings → Export Mapping Profile
2. **Import:** Go to Bridge Settings → Import Mapping Profile → Select entities to apply

A mapping profile bundles multiple entity mappings into a single JSON file that can be shared between installations.

### Profile Format

```json
{
  "version": 1,
  "name": "My Home Setup",
  "description": "Mappings for all devices",
  "author": "username",
  "createdAt": "2025-01-01T00:00:00Z",
  "domains": ["sensor", "fan", "vacuum", "switch"],
  "entryCount": 4,
  "entries": [
    {
      "domain": "sensor",
      "entityIdPattern": "sensor.*_temperature",
      "humidityEntity": "sensor.*_humidity",
      "pressureEntity": "sensor.*_pressure"
    },
    {
      "domain": "fan",
      "entityIdPattern": "fan.air_purifier*",
      "matterDeviceType": "air_purifier",
      "temperatureEntity": "sensor.air_purifier_temperature"
    }
  ]
}
```

:::tip
Entity ID patterns in profiles use glob-style matching. Use `*` to match any characters within the entity ID.
:::
