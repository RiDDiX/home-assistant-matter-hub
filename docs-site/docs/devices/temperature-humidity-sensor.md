# Temperature, Humidity & Pressure Sensor

Changed in v2.1.0. Earlier versions, up to v2.0.60, report humidity and pressure on the temperature sensor's endpoint.

Home Assistant often reports temperature, humidity, pressure, and battery level from a physical sensor as separate entities. By default, HAMH exposes each measurement on its own Matter endpoint. The temperature endpoint can also report the sensor's battery level.

| Feature Flag | Default | Effect |
|--------------|---------|--------|
| `autoHumidityMapping` | Enabled | Includes a humidity reading from the same Home Assistant device as a selected temperature sensor. |
| `autoPressureMapping` | Enabled | Includes a pressure reading from the same Home Assistant device as a selected temperature sensor. |
| `autoBatteryMapping` | Disabled | Adds a battery reading from the same device to the temperature endpoint. |
| `autoComposedDevices` | Disabled | Groups the measurements under one bridged device with a child endpoint per reading and battery on the parent. This enables all three automatic mappings. |

## Automatic and manual mapping

Select the temperature entity in the bridge filter. Automatic humidity and pressure mapping can include related entities that do not match the include rules. The filter preview shows direct matches. For separate endpoints, HAMH honors exclude rules and the source's **Disable this entity** setting. Home Assistant must enable the source in either layout. Separate endpoints for hidden sources require the bridge's **Include Hidden Entities** setting.

To use a particular source or a source on another Home Assistant device, edit the temperature entity's mapping. Select **Humidity Sensor**, **Pressure Sensor**, or **Battery Sensor** and save. Humidity and pressure sources normally use the corresponding Home Assistant device class. Manual links also accept template sensors with no device class that report humidity in percent or pressure in a recognized unit.

If the source also matches the bridge filter, it has one endpoint. With **Auto Composed Devices** enabled on a bridge, the readings appear as child endpoints of the composed device. You can exclude a mapped companion from standalone exposure and still use its reading in the composition. Server mode exposes separate endpoints and applies its ten-device limit.

## Existing bridges

The default temperature endpoint keeps its identity. Humidity and pressure readings that previously shared that endpoint now have separate endpoint IDs. Your controller may discover them as new devices.

Earlier versions of this page suggested ticking **Disable this entity** on the humidity and pressure entities, or excluding them, to avoid duplicates. With separate endpoints that setting now hides the reading. Re-enable the entity, or turn on **Auto Composed Devices**, to get it back. When such a setting keeps a humidity or pressure reading out, or a mapped source cannot be used, HAMH logs one warning that names the sensor and lists it on the Diagnostics page.

If a reading is missing, check that its source is enabled and reports a numeric value. For a separate endpoint, check its filter exclusions and mapping settings.

## Matter clusters

| Reading | Cluster |
|---------|---------|
| Temperature | TemperatureMeasurement |
| Humidity | RelativeHumidityMeasurement |
| Pressure | PressureMeasurement |
| Battery | PowerSource |

Matter pressure is reported in units of 0.1 kPa, numerically equal to hPa.

## Example Home Assistant Entities

Typical Zigbee H&T sensor entities:

```yaml
# Temperature sensor
sensor.h_t_bad_temperature:
  state: "21.5"
  attributes:
    device_class: temperature
    unit_of_measurement: "°C"
    friendly_name: "H&T Bad"

# Humidity sensor
sensor.h_t_bad_humidity:
  state: "58"
  attributes:
    device_class: humidity
    unit_of_measurement: "%"
    friendly_name: "H&T Bad Humidity"

# Pressure sensor
sensor.h_t_bad_pressure:
  state: "1013.25"
  attributes:
    device_class: atmospheric_pressure
    unit_of_measurement: "hPa"
    friendly_name: "H&T Bad Pressure"

# Battery sensor
sensor.h_t_bad_battery:
  state: "87"
  attributes:
    device_class: battery
    unit_of_measurement: "%"
    friendly_name: "H&T Bad Battery"
```
