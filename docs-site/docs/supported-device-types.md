# Supported Device Types

All device types Home-Assistant-Matter-Hub supports, with their capabilities, controller compatibility, and configuration options.

---

## Quick Reference

| Home Assistant Domain | Matter Device Type |
|-----------------------|-------------------|
| `light` | Light (OnOff / Dimmable / Color Temperature / Extended Color) |
| `switch`, `input_boolean` | On/Off Plug-in Unit |
| `lock` | Door Lock |
| `cover` | Window Covering |
| `climate` | Thermostat |
| `fan` | Fan |
| `sensor` | Temperature / Humidity / Pressure / Flow / Illuminance / Air Quality |
| `weather` | Temperature + Humidity + Pressure (composed) |
| `binary_sensor` | Contact / Occupancy / Smoke/CO / OnOff Sensor |
| `media_player` | Speaker |
| `valve` | Water Valve |
| `vacuum` | Robotic Vacuum Cleaner |
| `lawn_mower` | Robotic Vacuum Cleaner |
| `water_heater` | Thermostat (Heating) |
| `select`, `input_select` | Mode Select |
| `alarm_control_panel` | Mode Select |
| `event` | Generic Switch |
| `siren` | On/Off Plug-in Unit |
| `humidifier` | Fan (with humidity control) |

> [!NOTE]
> Controller compatibility varies by device type and firmware version. Not all controllers support all Matter device types. Check the official documentation below for current support status.

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

**Power & Energy Measurement:**
- Lights can optionally report electrical power and energy consumption via Matter clusters
- Lights are no longer auto-mapped. You must set `powerEntity` / `energyEntity` explicitly via Entity Mapping
- A light that used to show an energy readout may drop it after upgrading, add the mapping back to restore it ([#374](https://github.com/RiDDiX/home-assistant-matter-hub/issues/374))

**Controller Notes:**
- All major controllers support all light types
- Color temperature range may differ between HA and Matter specifications

See [Light Guide](./devices/light.md) for detailed setup, color conversion, and troubleshooting.

---

### Switches & Booleans (`switch`, `input_boolean`)

Mapped to **OnOffPlugInUnit** - a simple on/off controllable outlet.

**Supported Actions:**
- Turn on
- Turn off
- Toggle

**Power & Energy Measurement:**
- Switches can optionally report electrical power and energy consumption via Matter clusters
- Auto-mapped from HA power/energy sensor entities on the same device
- Manual mapping via Entity Mapping: `powerEntity`, `energyEntity`

**Use Cases:**
- Smart plugs
- Relays
- Virtual switches
- Helper booleans

---

### Locks (`lock`)

Mapped to **DoorLock** with PIN code support where available.

**Supported Actions:**
- Lock (no PIN required)
- Unlock (PIN required if configured)
- Unlatch / Unbolt (when HA entity supports `OPEN` feature)

**Supported States:**
- `locked` / `locking` → Matter Locked
- `unlocked` / `unlocking` → Matter Unlocked
- `open` / `opening` → Matter Unlatched

**Feature Flags:**
- **PIN Credentials** - Configure PIN codes via Entity Mapping UI
- **Lock without PIN** - Locking is always allowed, only unlock requires PIN (Alpha)
- **Unlatch (Unbolting)** - Automatically enabled when HA lock supports `OPEN` feature. Maps to `lock.open` action. Apple Home shows an "Unlatch" button.

**Controller Notes:**
- PIN code entry may not be supported by all controllers
- Some controllers may require additional confirmation for unlock
- Google Home has disabled voice unlock for Matter locks (Google policy)
- Apple Home shows an "Unlatch" button when the lock supports the Unbolting feature

See [Lock Guide](./devices/lock.md) for PIN credentials, unlatch setup, and troubleshooting.

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

**Feature Flags (Bridge Settings):**
| Flag | Description |
|------|-------------|
| `coverDoNotInvertPercentage` | Skip percentage inversion (not Matter compliant) |
| `coverUseHomeAssistantPercentage` | Display HA percentages in Matter (Alexa-friendly) |
| `coverSwapOpenClose` | Swap open/close commands (fixes reversed Alexa commands) |

**Supported Device Classes:**
- `blind`
- `curtain`
- `shade`
- `shutter`
- `awning`
- `garage` (limited support)

See [Cover Guide](./devices/cover.md) for percentage mapping, feature flags, and troubleshooting.

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
- `current_temperature` → Local Temperature (falls back to setpoint if unavailable)
- `target_temp_high` / `target_temp_low` → Setpoints
- `hvac_action` → Running State (active heating/cooling display)
- `min_temp` / `max_temp` → Thermostat limits

> **Auto display needs `hvac_action`:** Under Auto, controllers show whether the device is heating or cooling right now from the running state, which HAMH maps from HA `hvac_action`. ACs that do not publish `hvac_action` (many IR / SmartIR blasters) leave it empty, so Apple Home falls back to comparing the temperature against the setpoints and may show Cooling then flip to Heating once the target is reached, even while the AC keeps cooling ([#309](https://github.com/RiDDiX/home-assistant-matter-hub/issues/309)).

**Feature Variants (auto-detected from HA hvac_modes):**
- **Heating Only**: Heat-only TRVs, water heaters, exposes only `Heating` feature
- **Cooling Only**: Cool-only ACs, exposes only `Cooling` feature
- **Heating + Cooling**: Devices with `heat` and `cool` but no `heat_cool`, exposes `Heating` + `Cooling` without AutoMode. Apple Home won't show Auto button, preventing mode flipping.
- **Full HVAC (AutoMode)**: Devices with `heat_cool` in hvac_modes, exposes `Heating` + `Cooling` + `AutoMode` with dual setpoints
- **heat_cool-only zones** *(new in v2.0.27)*: Devices with `heat_cool` but no explicit `heat` or `cool` mode (e.g. zoned ACs), exposes `Heating` + `Cooling` without AutoMode. The `controlSequenceOfOperation` dynamically switches between `CoolingOnly` and `HeatingOnly` based on `hvac_action`. ([#207](https://github.com/RiDDiX/home-assistant-matter-hub/issues/207))

> **New in v2.0.20:** AutoMode is now only exposed when the device supports `heat_cool` (dual setpoint) in Home Assistant. Devices with only `auto` mode (single setpoint, device decides) no longer get AutoMode, which previously caused Apple Home to send conflicting commands and mode flipping.

> **New in v2.0.27:** Devices with `auto` + `cool` but no explicit `heat` mode (e.g. SmartIR ACs) no longer crash with a Matter conformance error. The `controlSequenceOfOperation` is now dynamically set to `CoolingOnly` or `HeatingOnly` instead of `CoolingAndHeating` for devices without AutoMode capability. ([#28](https://github.com/RiDDiX/home-assistant-matter-hub/issues/28))

This prevents Alexa from rejecting commands on single-capability thermostats ([#136](https://github.com/RiDDiX/home-assistant-matter-hub/issues/136)).

**Temperature Display Unit:**
The `ThermostatUserInterfaceConfiguration` cluster exposes your HA temperature unit preference (°C or °F) to Matter controllers.

See [Climate Guide](./devices/climate.md) for detailed feature variants, mode mapping, and troubleshooting.

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
| Oscillation | FanControl Rocking |

**Wind Modes:**
| Feature | Description |
|---------|-------------|
| **Oscillation** | Maps `oscillating` attribute to Matter Rocking |
| **Natural Wind** | Maps "Natural" preset mode to naturalWind |
| **Sleep Wind** | Maps "Sleep" preset mode to sleepWind |

**Entity Mapping:**
- Can be mapped to **Air Purifier** device type via Entity Mapping UI
- Air Purifier supports `filterLifeEntity` for HEPA filter monitoring

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

#### Auto Sensor Grouping

HAMH can automatically combine related sensors from the same HA device into a single Matter endpoint:

| Feature Flag | Description |
|--------------|-------------|
| `autoBatteryMapping` | Combines battery sensor with the primary sensor (default: disabled) |
| `autoHumidityMapping` | Combines humidity sensor with temperature sensor (default: enabled) |
| `autoPressureMapping` | Combines pressure sensor with temperature sensor (default: enabled) |

You can also manually assign sensors via **Entity Mapping**:
- `batteryEntity`, Battery sensor entity ID
- `humidityEntity`, Humidity sensor entity ID
- `pressureEntity`, Pressure sensor entity ID

See [Temperature & Humidity Sensor](./devices/temperature-humidity-sensor.md) for detailed setup instructions.

---

### Weather (`weather`)

Mapped to **TemperatureSensor** with Humidity and Pressure measurement clusters stacked on one device. A weather entity's state is the text condition (e.g. `sunny`), so the readings come from its attributes.

**Supported Attributes:**
- `temperature` + `temperature_unit` → Temperature
- `humidity` (%) → Humidity
- `pressure` + `pressure_unit` (`hPa`, `mbar`, `inHg`, `mmHg`) → Pressure (converted to hPa)

**Behavior:**
- On by default. A `weather.*` entity matching your bridge filter is exposed automatically. Use the per-entity `disabled` mapping to suppress one you do not want.
- Humidity and Pressure are optional; a missing reading reports no value instead of zero.

**Controller Notes:**
- Temperature and Humidity work where the standalone sensor types do (Apple, Google, Alexa).
- Pressure is Google-only. Apple Home does not display barometric pressure and Alexa does not support the Pressure cluster.
- The three measurements are stacked on a single TemperatureSensor device. How each controller renders the extra clusters is not yet community-tested.

---

### Binary Sensors (`binary_sensor`)

Mapped based on `device_class` attribute.

| Device Class | Matter Device Type | Controller Display |
|--------------|-------------------|--------------------|
| `running`, `plug`, `power`, `battery_charging`, `light` | OnOffSensor | On/Off |
| `door`, `window`, `garage_door`, `opening`, `lock` | ContactSensor | Open/Closed |
| `cold` | Contact Sensor (default) | Open/Closed |
| `battery`, `heat`, `connectivity`, `problem`, `safety`, `sound`, `tamper`, `update`, `vibration` | ContactSensor | Open/Closed |
| `motion`, `moving` | OccupancySensor (PIR) | Motion detected/Clear |
| `occupancy`, `presence` | OccupancySensor (PhysicalContact) | Occupied/Clear |
| `moisture` | Contact Sensor (default) | Open/Closed |
| `smoke` | SmokeCoAlarm (Smoke) | Alarm |
| `carbon_monoxide`, `gas` | SmokeCoAlarm (CO) | Alarm |
| Other / unset | OnOffSensor | On/Off |

> [!NOTE]
> Leak (`moisture`) and freeze (`cold`) `binary_sensor`s default to a Matter 1.3 Contact Sensor, which keeps Alexa bridges stable. The Matter 1.4 Water Leak, Water Freeze, and Rain detector types are opt-in per entity via the device-type override ([#365](https://github.com/RiDDiX/home-assistant-matter-hub/issues/365)).

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

**Device Type Override:**
Media players can be overridden to other device types via Entity Mapping. For example, mapping a media player to **OnOffPlugInUnit** (switch) makes it appear as a simple on/off switch in controllers like Alexa, useful when you only need power control.

**Controller Notes:**
- Media player support in Matter is limited
- Not all controllers support all features
- Best support in Apple Home

---

### Events (`event`)

Mapped to **GenericSwitch** device.

**Supported Use Cases:**
- Doorbells
- Button events
- Remote control button presses

**Behavior:**
- Events from HA `event.*` entities are forwarded as Matter GenericSwitch position changes
- Controllers can react to button press events

**Doorbell Override (experimental):**
An `event` entity (typically `device_class: doorbell`) can be switched to the Matter **Doorbell** type (0x148) via the Entity Mapping UI. It carries the same momentary Switch cluster, only the device type changes. Only SmartThings renders 0x148 as a doorbell today; other controllers don't know the type and fall back to the Switch cluster, if they show the device at all. The default stays GenericSwitch, and switching an already-paired entity needs a re-pair.

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
- State always shows as "off" (scripts are momentary actions)

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

Mapped to **Fan** device with humidity control.

> Note: Matter does not have a native humidifier device type. The Fan device type is used as the closest match, with the FanControl cluster mapped to humidity level.

**Supported Features:**
- On/Off
- Target humidity (as fan speed percentage)
- Auto mode (if available modes include "auto")

---

### Vacuums (`vacuum`)

Mapped to **RoboticVacuumCleaner**.

**Supported Features:**
- Start/Stop cleaning
- Return to dock
- Operating mode (Idle, Cleaning)
- Room selection (if supported by vacuum)
- Cleaning mode selection (Sweeping, Mopping, Sweeping and mopping, Mopping after sweeping)
- Battery level (if available)

**Entity Mapping Options:**
| Option | Description |
|--------|-------------|
| `roomEntities` | Array of button entity IDs for room selection (Roborock) |
| `batteryEntity` | External battery sensor entity (Roomba, Deebot) |
| `cleaningModeEntity` | Select entity for cleaning mode (Dreame, Ecovacs, etc.) |
| `suctionLevelEntity` | Select entity for suction level, adds Quiet/Max intensity toggles to Apple Home's extra features panel |
| `mopIntensityEntity` | Select entity for mop intensity / water level, adds mop intensity modes to Apple Home's extra features panel |

**Feature Flags (Bridge Settings):**
| Flag | Description |
|------|-------------|
| `serverMode` | Expose as standalone device (required for Apple Home/Alexa) |
| `vacuumIncludeUnnamedRooms` | Include rooms without names in room selection |

**Important Limitations:**
- **Server Mode recommended** - For full voice command support (Siri, Alexa)
- **Server Mode = one device per bridge** - The vacuum must be the only device
- **Apple Home** requires iOS/tvOS/AudioOS 18.4+ on all Home hubs
- **Google Home** has limited RVC support, basic start/stop works, room selection and cleaning modes may vary

See [Robot Vacuum Guide](./devices/robot-vacuum.md) for detailed setup instructions.

> **Note:** `lawn_mower` entities reuse the RVC mapping (start/pause/dock, battery, charging state) via the `robotic_lawn_mower` override ([#301](https://github.com/RiDDiX/home-assistant-matter-hub/issues/301)).

---

### Alarm Control Panel (`alarm_control_panel`)

Mapped to **ModeSelectDevice** (0x0027). Each alarm state becomes a selectable mode.

**Supported Modes:**
- Disarmed
- Armed Home
- Armed Away
- Armed Night
- Armed Vacation
- Armed Custom Bypass

**Behavior:**
- Changing mode from a controller calls the corresponding `alarm_control_panel.alarm_*` action in HA
- Current mode reflects the entity's current alarm state
- For Apple Home compatibility, an OnOff fallback is included: turning "on" arms the alarm, turning "off" disarms it

**Controller Notes:**
- Matter does not have a native alarm panel device type, so ModeSelect is used as the closest match
- Voice commands like "Hey Siri, set alarm to Armed Away" may not work, use the controller app to switch modes

---

### Select / Input Select (`select`, `input_select`)

Mapped to **ModeSelectDevice** (0x0027). Each option in the select entity becomes a selectable mode.

**Behavior:**
- Each option is exposed as a numbered mode
- Changing mode from a controller calls `select.select_option` in HA
- Current mode reflects the entity's current state

**Use Cases:**
- Washing machine programs
- HVAC operation modes
- Irrigation zones
- Scene selectors
- Any entity with a fixed list of options

**Configuration:** No special setup needed. `select` and `input_select` entities matching your bridge filter are automatically exposed. You can also manually assign the `Mode Select` device type via Entity Mapping.

---

### Automations (`automation`)

Mapped to **OnOffPlugInUnit**.

**Behavior:**
- Turning "on" triggers the automation (runs it once)
- Turning "off" disables the automation
- State reflects the automation's enabled/disabled status

---

### Remotes (`remote`)

Mapped to **OnOffPlugInUnit**.

**Behavior:**
- Turning "on" calls `remote.turn_on` in HA
- Turning "off" calls `remote.turn_off` in HA
- State reflects the remote entity's on/off state

---

### Sirens (`siren`)

Mapped to **OnOffPlugInUnit**.

**Supported Actions:**
- Turn on → `siren.turn_on`
- Turn off → `siren.turn_off`

**Behavior:**
- State reflects the siren entity's on/off state in HA
- Appears as a simple on/off device in all controllers

**Controller Notes:**
- Supported by all major controllers (Apple Home, Google Home, Alexa, SmartThings) as a standard on/off device

---

### Dishwashers (Entity Mapping Override)

Available as a **device type override** for `switch` entities via the Entity Mapping UI. Maps to the Matter **Dishwasher** device type with OperationalState and OnOff clusters.

**HA State → Matter OperationalState Mapping:**
| HA State | Matter State |
|----------|-------------|
| `off`, `idle`, `standby`, `complete`, `finished` | Stopped |
| `on`, `running`, `active`, `drying`, `washing` | Running |
| `paused` | Paused |

**Supported Commands:**
- **Start** → `homeassistant.turn_on`
- **Stop** → `homeassistant.turn_off`
- **Resume** → `homeassistant.turn_on`
- **Pause** → Not supported (returns error)

**Controller Notes:**
- **Google Home**: Supported
- **Amazon Alexa**: Supported
- **Samsung SmartThings**: Supported
- **Apple Home**: Not supported (Apple does not support the Dishwasher device type)

---

## Entity Mapping Customization

You can override the default device type mapping per entity using the Entity Mapping UI.

**Available Override Types:**
- OnOffLight
- DimmableLight
- ColorTemperatureLight
- ExtendedColorLight
- OnOffPlugInUnit
- OnOffSwitch (now produces a real 0x0100 On/Off Light with an OnOff server that controllers render as a switch, instead of the old no-op plug; opt-in users need a one-time re-pair. All controllers treat 0x0100 as a light, so Alexa's "turn off all lights" will toggle it too) ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380))
- MountedOnOffControl (experimental Matter 1.4 type 0x010F. SmartThings and Aqara show it as a real switch; Apple, Google and Alexa don't know the type yet and are expected to fall back to the plug subset the endpoint also advertises, not yet verified on real devices) ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380))
- DoorLock
- WindowCovering
- Thermostat
- Fan
- AirPurifier
- RobotVacuumCleaner
- Humidifier/Dehumidifier
- Speaker
- BasicVideoPlayer
- HumiditySensor, TemperatureSensor, PressureSensor, LightSensor, FlowSensor
- AirQualitySensor, BatteryStorage, TVOCSensor
- WaterValve, Pump
- WaterHeater
- WaterHeaterManagement — "Water Heater with Boost (Matter 1.4)", the 0x050F device type with the WaterHeaterManagement (Boost / CancelBoost), WaterHeaterMode and heating Thermostat clusters. Opt-in: it is aimed at energy-management controllers, no mainstream controller renders 0x050F yet, and switching an already-paired entity to it needs a re-pair
- Dishwasher
- GenericSwitch
- Doorbell (experimental 0x148 for `event` entities. Only SmartThings renders it as a doorbell; other controllers don't know the type yet and fall back to the momentary Switch cluster the endpoint also carries. Switching an already-paired entity needs a re-pair)
- SmokeCO Alarm, Water Leak Detector, Water Freeze Detector

**Use Cases:**
- Map a `media_player` to OnOffPlugInUnit for simple on/off switch in Alexa
- Map a `fan` to Air Purifier type for HEPA filter monitoring
- Map a `switch` to Pump type
- Map a `switch` to Dishwasher type for OperationalState support (Google/Alexa/SmartThings)
- Force a specific light type

> **Note:** Since v2.0.25, entity mapping changes take effect automatically within ~30 seconds. No bridge restart is required.

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

**Workaround:** There is currently no bridge-side workaround for this Alexa behavior. Use voice commands ("Alexa, dim the lights to 50%") which work reliably.

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
