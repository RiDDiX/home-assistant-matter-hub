# Supported Device Types

This document provides comprehensive information about all device types supported by Home-Assistant-Matter-Hub, including their capabilities, controller compatibility, and configuration options.

---

## Quick Reference

| Home Assistant Domain | Matter Device Type | Apple Home | Google Home | Alexa |
|-----------------------|-------------------|:----------:|:-----------:|:-----:|
| `light` | Light (various) | | | |
| `switch` | On/Off Plug-in Unit | | | |
| `lock` | Door Lock | | | |
| `cover` | Window Covering | | | |
| `climate` | Thermostat | | | |
| `fan` | Fan | | | |
| `sensor` | Various Sensors | | | |
| `binary_sensor` | Various Sensors | | | |
| `media_player` | Speaker | | | |
| `valve` | Water Valve | | | |
| `vacuum` | Robotic Vacuum | | | |

**Legend:** | Full Support | | Partial/Limited | | Not Supported

---

## Controller Compatibility Links

- **Alexa**: [Matter Support Documentation](https://developer.amazon.com/en-US/docs/alexa/smarthome/matter-support.html#device-categories-and-clusters)
- **Google Home**: [Supported Devices](https://developers.home.google.com/matter/supported-devices#device_type_and_control_support)
- **Apple Home**: [Matter Accessories](https://support.apple.com/en-us/102135)

---

## Detailed Device Types

### Lights (`light`)

Home Assistant lights are mapped to the appropriate Matter light type based on supported features.

| HA Features | Matter Device Type | Capabilities |
|-------------|-------------------|--------------|
| On/Off only | OnOffLight | Power control |
| Brightness | DimmableLight | Power + brightness |
| Color temp | ColorTemperatureLight | Power + brightness + temperature |
| RGB/HS/XY | ExtendedColorLight | Full color control |

**Supported Attributes:**
- `brightness` (0-255) → Matter Level (0-254)
- `color_temp` (mireds) → Matter Color Temperature (Kelvin)
- `rgb_color` / `hs_color` / `xy_color` → Matter Hue/Saturation or XY

**Controller Notes:**
- All major controllers support all light types
- Color temperature range may differ between HA and Matter specifications

---

### Switches & Booleans (`switch`, `input_boolean`)

Mapped to **OnOffPlugInUnit** - a simple on/off controllable outlet.

**Supported Actions:**
- Turn on
- Turn off
- Toggle

**Use Cases:**
- Smart plugs
- Relays
- Virtual switches
- Helper booleans

---

### Locks (`lock`)

Mapped to **DoorLock** with PIN code support where available.

**Supported Actions:**
- Lock
- Unlock

**Supported Attributes:**
- `is_locked` → Matter Lock State

**Controller Notes:**
- PIN code entry may not be supported by all controllers
- Some controllers may require additional confirmation for unlock

---

### Covers (`cover`)

Mapped to **WindowCovering** supporting position and tilt control.

**Supported Features:**
| HA Feature | Matter Capability |
|------------|------------------|
| `open` / `close` | Open/Close commands |
| `set_position` | Lift percentage (0-100%) |
| `set_tilt_position` | Tilt percentage (0-100%) |
| `stop` | Stop movement |

**Supported Device Classes:**
- `blind`
- `curtain`
- `shade`
- `shutter`
- `awning`
- `garage` (limited support)

---

### Climate (`climate`)

Mapped to **Thermostat** with heating, cooling, and auto modes.

**Supported HVAC Modes:**
| HA Mode | Matter SystemMode |
|---------|------------------|
| `off` | Off |
| `heat` | Heat |
| `cool` | Cool |
| `heat_cool` | Auto |
| `auto` | Auto* |
| `dry` | Dry |
| `fan_only` | FanOnly |

> **Important:** Matter's "Auto" mode means automatic switching between heat/cool based on temperature. This matches HA's `heat_cool` mode, NOT the `auto` mode which typically means "device decides".

**Supported Attributes:**
- `current_temperature` → Local Temperature
- `target_temp_high` / `target_temp_low` → Setpoints
- `hvac_action` → Running State

**Features by Mode:**
- **Heating Only**: Single setpoint, heat mode only
- **Cooling Only**: Single setpoint, cool mode only  
- **Heat + Cool**: Dual setpoints, auto mode available

---

### Fans (`fan`)

Mapped to **Fan** device with speed and direction control.

**Supported Features:**
| HA Feature | Matter Capability |
|------------|------------------|
| On/Off | FanControl On/Off |
| Speed percentage | FanControl SpeedPercent |
| Preset modes | FanControl FanMode |
| Direction | FanControl AirflowDirection |

**Speed Mapping:**
- HA percentage (0-100%) → Matter percentage (0-100)
- Named presets mapped to Low/Medium/High/Auto

---

### Sensors (`sensor`)

Various sensor types mapped based on `device_class` and `unit_of_measurement`.

#### Temperature Sensor
- **Device Class:** `temperature`
- **Units:** `°C`, `°F`
- **Matter Type:** TemperatureSensor

#### Humidity Sensor
- **Device Class:** `humidity`
- **Units:** `%`
- **Matter Type:** HumiditySensor

#### Pressure Sensor
- **Device Class:** `pressure`, `atmospheric_pressure`
- **Units:** `hPa`, `mbar`, `kPa`, `Pa`
- **Matter Type:** PressureSensor

#### Flow Sensor
- **Device Class:** `volume_flow_rate`
- **Units:** `m³/h`, `L/min`, `gal/min`
- **Matter Type:** FlowSensor

#### Illuminance Sensor
- **Device Class:** `illuminance`
- **Units:** `lx`
- **Matter Type:** IlluminanceSensor

#### Air Quality Sensors
| Device Class | Matter Cluster |
|--------------|----------------|
| `aqi` | AirQuality |
| `pm25` | PM2.5 Concentration |
| `pm10` | PM10 Concentration |
| `co2` | CO2 Concentration |
| `volatile_organic_compounds` | TVOC Concentration |

---

### Binary Sensors (`binary_sensor`)

Mapped based on `device_class` attribute.

| Device Class | Matter Device Type | Controller Support |
|--------------|-------------------|-------------------|
| `door`, `window`, `garage_door` | ContactSensor | | All |
| `motion`, `occupancy`, `presence` | OccupancySensor | | All |
| `moisture`, `water` | WaterLeakDetector | | Limited |
| `smoke` | SmokeCoAlarm (Smoke) | | Limited |
| `carbon_monoxide` | SmokeCoAlarm (CO) | | Limited |
| `gas` | SmokeCoAlarm (Gas) | | Limited |
| Other | OnOffSensor | | All |

---

### Media Players (`media_player`)

Mapped to **Speaker** device with volume and playback control.

**Supported Features:**
- On/Off
- Volume control (0-100%)
- Mute
- Play/Pause
- Stop
- Next/Previous track

**Controller Notes:**
- Media player support in Matter is limited
- Not all controllers support all features
- Best support in Apple Home

---

### Buttons (`button`, `input_button`)

Mapped to **OnOffPlugInUnit** with auto-off behavior.

**Behavior:**
1. Controller sends "turn on" command
2. Button press is triggered in HA
3. Device automatically turns off after 3 seconds

---

### Scenes (`scene`)

Mapped to **OnOffPlugInUnit** with activate-only behavior.

**Behavior:**
- Turning "on" activates the scene
- State always shows as "off" after activation

---

### Scripts (`script`)

Mapped to **OnOffPlugInUnit**.

**Behavior:**
- Turning "on" executes the script
- Shows as "on" while running, "off" when complete

> **Note:** Scripts that are hidden in Home Assistant (`hidden_by: user`) will still be included if explicitly matched by your filter configuration.

---

### Valves (`valve`)

Mapped to **WaterValve** device.

**Supported Actions:**
- Open valve
- Close valve

**Controller Support:**
- Apple Home: | Limited
- Google Home: | Limited
- Alexa: | Limited

---

### Humidifiers (`humidifier`)

Mapped to **OnOffPlugInUnit** with level control.

> Note: Matter does not have a native humidifier device type yet.

**Supported Features:**
- On/Off
- Target humidity (as level percentage)

---

### Vacuums (`vacuum`)

Mapped to **RoboticVacuumCleaner**.

**Supported Features:**
- Start/Stop cleaning
- Return to dock
- Operating mode

**Important Limitations:**
- | **Apple Home only** - Not supported by Google or Alexa yet
- | **Must be the ONLY device** in its bridge
- | Requires iOS/tvOS/AudioOS 18.4+ on all Home hubs

---

### Automations (`automation`)

Mapped to **OnOffPlugInUnit**.

**Behavior:**
- Turning "on" enables the automation
- Turning "off" disables the automation
- State reflects enabled/disabled status

---

## Entity Mapping Customization

In the Alpha/Testing versions, you can override the default device type mapping per entity.

**Available Override Types:**
- OnOffLight
- DimmableLight
- ColorTemperatureLight
- ExtendedColorLight
- OnOffPlugInUnit
- AirPurifier
- Pump
- (more in future versions)

**Use Cases:**
- Map a fan to Air Purifier type
- Map a switch to Pump type
- Force a specific light type

---

## Known Controller Limitations

### Google Home

#### Light Brightness Reset After Extended Off Period

**Issue:** When a light has been off for several minutes (typically 5+), turning it on via Google Home may set brightness to 100% instead of the last used value.

**Cause:** This is a Google Home / Matter.js interaction issue. Google Home sends brightness commands without the required `transitionTime` field after subscription renewals, causing validation errors in Matter.js before the bridge can process the command.

**Workaround - Home Assistant Blueprint:**

Create a blueprint that stores brightness on turn-off and restores it on turn-on:

<details>
<summary>Click to expand Blueprint YAML</summary>

```yaml
blueprint:
  name: Matter/Google - Restore brightness after delayed ON
  description: >
    Workaround for Google Home / Matter bridge behavior that turns lights on at 100%
    after being off for a while. Stores brightness on turn_off and restores it on
    turn_on if the light was off for at least X minutes.
  domain: automation
  input:
    light_target:
      name: Light entity
      selector:
        entity:
          domain: light
    brightness_store:
      name: Helper to store last brightness (input_number, 1..255)
      selector:
        entity:
          domain: input_number
    off_minutes_threshold:
      name: Minutes off before restore
      default: 5
      selector:
        number:
          min: 1
          max: 120
          mode: slider
          step: 1
    restore_only_if_100pct:
      name: Only restore if Google turned it on at ~100%
      description: If enabled, restore only when current brightness is very high (>=250).
      default: true
      selector:
        boolean: {}

mode: restart

trigger:
  - platform: state
    entity_id: !input light_target
    to: "off"
    id: turned_off
  - platform: state
    entity_id: !input light_target
    to: "on"
    id: turned_on

variables:
  light_entity: !input light_target
  store_entity: !input brightness_store
  minutes_threshold: !input off_minutes_threshold
  only_if_100: !input restore_only_if_100pct

action:
  - choose:
      - conditions:
          - condition: trigger
            id: turned_off
        sequence:
          - variables:
              prev_brightness: "{{ state_attr(light_entity, 'brightness') }}"
          - condition: template
            value_template: "{{ prev_brightness is number and prev_brightness|int > 0 }}"
          - service: input_number.set_value
            target:
              entity_id: "{{ store_entity }}"
            data:
              value: "{{ prev_brightness|int }}"
      - conditions:
          - condition: trigger
            id: turned_on
        sequence:
          - delay: "00:00:02"
          - variables:
              was_off_seconds: >
                {{ (as_timestamp(now()) - as_timestamp(states[light_entity].last_changed)) | int }}
              threshold_seconds: "{{ (minutes_threshold | int) * 60 }}"
              current_brightness: "{{ state_attr(light_entity, 'brightness') | int(0) }}"
              saved_brightness: "{{ states(store_entity) | int(0) }}"
          - condition: template
            value_template: >
              {{ saved_brightness > 0 and (not only_if_100 or current_brightness >= 250) }}
          - service: light.turn_on
            target:
              entity_id: "{{ light_entity }}"
            data:
              brightness: "{{ saved_brightness }}"
```

</details>

**Setup:**
1. Create an `input_number` helper for each light (range 1-255)
2. Import the blueprint or create an automation with the YAML above
3. Configure: select your light entity and the corresponding helper

**Alternative:** Use voice commands ("Hey Google, dim the lights to 50%") which work reliably.

#### Cover Automations Not Available

**Issue:** Window covering devices (blinds, shutters, curtains) cannot be used as actions in Google Home Automations. When selecting a cover device, "no actions available" is shown.

**Cause:** This is a Google Home limitation with Matter WindowCovering devices. The same issue affects native Matter blinds (e.g., Smartwings).

**Workarounds:**
1. Use Google Home Routines with voice commands ("Hey Google, close [cover name]")
2. Create Home Assistant scripts and expose them as switches via HAMH
3. Use Home Assistant automations instead of Google Home automations

---

### Amazon Alexa / Echo Devices

#### Light Brightness Reset on Turn-On

**Issue:** After a subscription renewal (approximately every 5 minutes), Alexa may reset light brightness to 100% when turning on a light, even if it was previously dimmed to a different level.

**Cause:** This is an Alexa-side behavior where Echo devices send an explicit `moveToLevel(254)` command immediately after the `on()` command following a new subscription.

**Evidence:**
- The same behavior occurs with other Matter bridges
- Logs show Alexa explicitly sending `level: 254` after `on()` commands
- This does NOT happen immediately after dimming, only after subscription renewal

**Workaround:** A feature flag `alexaPreserveBrightnessOnTurnOn` is available in Alpha/Testing versions. When enabled, the bridge will ignore brightness commands that set the light to 100% immediately after a turn-on command.

---

## Requesting New Device Types

Before requesting a new device type, please verify:

1. The device type exists in the [Matter Specification](https://handbook.buildwithmatter.com/how-it-works/device-types/)
2. Your controller supports the device type
3. There isn't an existing mapping that works

To request a new device type, [open a feature request](https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=enhancement) with:
- Home Assistant domain and device class
- Desired Matter device type
- Your use case
- Which controller(s) you use
