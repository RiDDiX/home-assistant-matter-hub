# Temperature, Humidity & Pressure Sensor

Many Zigbee-based sensors (like Xiaomi Aqara WSDCGQ11LM, Sonoff SNZB-02, etc.) report temperature, humidity, pressure, and battery level as **separate entities** in Home Assistant. This can result in multiple individual devices appearing in your Matter controller instead of one unified device.

With **Auto Sensor Grouping** and **Entity Mapping**, you can combine these into a **single Matter device** that shows temperature, humidity, pressure, and battery status together.

## Features

- **Combined Device** - Single device in Apple Home, Google Home, Alexa instead of 3-4 separate ones
- **Temperature** - Primary measurement from your temperature sensor
- **Humidity** - Linked from a separate humidity sensor entity
- **Pressure** - Linked from a separate pressure sensor entity
- **Battery Level** - Optional battery status from a separate battery sensor entity
- **Auto Grouping** - HAMH automatically combines sensors from the same HA device (no manual config needed)
- **Device Name** - Uses your Home Assistant entity name (e.g., "H&T Bad")

## How It Works

### Automatic Grouping (Recommended)

Since v2.0.17, HAMH automatically detects related sensors on the same HA device and combines them. This is controlled by three feature flags in Bridge Settings:

| Feature Flag | Default | Description |
|--------------|---------|-------------|
| `autoHumidityMapping` | Enabled | Combines humidity with temperature |
| `autoPressureMapping` | Enabled | Combines pressure with temperature |
| `autoBatteryMapping` | Enabled | Adds battery to any primary sensor |

With auto grouping, you don't need to configure anything manually. The sensors are combined automatically based on their HA device assignment.

### Manual Mapping

You can also manually configure which sensors to combine using Entity Mapping.

Instead of exposing each sensor entity separately:

| Without Mapping | With Mapping |
|-----------------|------------|
| H&T Bad Temperature | **H&T Bad** (combined) |
| H&T Bad Humidity |, (still gets its own standalone endpoint) |
| H&T Bad Pressure |, (auto-assigned to temperature) |
| H&T Bad Battery |, (auto-assigned to temperature) |

The combined device reports all values in one place.

> **Note:** Humidity entities still create their own standalone endpoint even when auto-assigned to a temperature sensor, because Apple Home only displays humidity on dedicated HumiditySensor endpoints.

## Configuration

### Step 1: Identify Your Entities

In Home Assistant, find your related sensor entities. For example, a typical Zigbee H&T sensor creates:

- `sensor.h_t_bad_temperature` - Temperature measurement
- `sensor.h_t_bad_humidity` - Humidity measurement  
- `sensor.h_t_bad_pressure` - Pressure measurement
- `sensor.h_t_bad_battery` - Battery percentage

### Step 2: Configure Entity Mapping

1. Go to your **Bridge** in the Dashboard
2. Find your **temperature** sensor entity (e.g., `sensor.h_t_bad_temperature`)
3. Click **Edit Mapping**
4. Fill in the optional fields:
   - **Humidity Sensor**: `sensor.h_t_bad_humidity`
   - **Pressure Sensor**: `sensor.h_t_bad_pressure`
   - **Battery Sensor**: `sensor.h_t_bad_battery`
5. Click **Save**

> **Tip:** If auto grouping is enabled (default), you typically don't need to do this manually. Only use manual mapping if your sensors are on different HA devices or if auto grouping doesn't detect them correctly.

### Step 3: Exclude the Individual Entities

To prevent duplicate devices in your Matter controller:

1. Find the humidity entity (`sensor.h_t_bad_humidity`)
2. Click **Edit Mapping** → Enable **"Disable this entity"**
3. Repeat for the battery entity (`sensor.h_t_bad_battery`)

Or simply don't include them in your bridge's entity filter.

### Step 4: Re-pair (if necessary)

If your devices were already paired, you may need to remove and re-add them in your Matter controller because the device capabilities have changed.

## Example Configuration

For a sensor named "H&T Bad" with these entities:

| Entity | Mapping |
|--------|--------|
| `sensor.h_t_bad_temperature` | **Primary** - Set `humidityEntity`, `pressureEntity`, and `batteryEntity` |
| `sensor.h_t_bad_humidity` | Keeps its own endpoint (Apple Home needs standalone HumiditySensor) |
| `sensor.h_t_bad_pressure` | Auto-assigned or **Disabled** / excluded from bridge |
| `sensor.h_t_bad_battery` | Auto-assigned or **Disabled** / excluded from bridge |

Result: One combined device "H&T Bad" showing temperature, humidity, pressure, and battery.

## Compatibility

| Controller | Temperature | Humidity | Pressure | Battery |
|------------|-------------|----------|----------|----------|
| Apple Home | ✅ | ✅ | ✅ | ✅ |
| Google Home | ✅ | ✅ | ✅ | ✅ |
| Amazon Alexa | ✅ | ✅ | ✅ | ⚠️ Limited |

## Technical Details

The combined sensor uses these Matter clusters:

- **TemperatureMeasurement** - From the primary temperature entity
- **RelativeHumidityMeasurement** - From the linked humidity entity
- **PressureMeasurement** - From the linked pressure entity (in dPa)
- **PowerSource** - Battery level from the linked battery entity

Pressure values are converted to deciPascals (dPa) for Matter. Supported HA units: hPa, mbar, kPa, Pa.

## Troubleshooting

### Humidity/Battery not showing

1. Verify the entity IDs are correct (check spelling, case sensitivity)
2. Confirm the linked sensors provide numeric values
3. Remove and re-add the device in your Matter controller

### Device shows incorrect name

The Matter device name comes from your primary temperature entity's `friendly_name` in Home Assistant. Customize it there or use the **Custom Name** field in Entity Mapping.

### Old individual devices still appear

After configuring the combined sensor:

1. Disable or exclude the individual humidity/battery entities
2. Remove old devices from your Matter controller
3. Re-pair the bridge if necessary

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
