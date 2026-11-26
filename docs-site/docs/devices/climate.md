# Climate / Thermostat

Home Assistant `climate` entities are mapped to Matter **Thermostat** devices. The bridge auto-detects your device's capabilities from its `hvac_modes` attribute and exposes the correct feature set.

## Feature Variants

The thermostat type is automatically selected based on which HVAC modes your device supports:

| HA hvac_modes | Matter Features | Description |
|---------------|----------------|-------------|
| `heat` only | Heating | Heat-only TRVs, water heaters |
| `cool` only | Cooling | Cool-only ACs |
| `heat` + `cool` (no `heat_cool`) | Heating + Cooling | Dual-mode without auto switching. Apple Home won't show Auto button. |
| `heat_cool` present | Heating + Cooling + AutoMode | Full HVAC with dual setpoints |
| `heat_cool` only (no explicit `heat`/`cool`) | Heating + Cooling | Zoned ACs, `controlSequenceOfOperation` switches dynamically based on `hvac_action` |

## HVAC Mode Mapping

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

## Supported Attributes

| HA Attribute | Matter Property | Notes |
|-------------|----------------|-------|
| `current_temperature` | Local Temperature | Falls back to setpoint if unavailable |
| `temperature` | Occupied Heating/Cooling Setpoint | Single setpoint modes |
| `target_temp_high` | Occupied Cooling Setpoint | Auto mode (dual setpoint) |
| `target_temp_low` | Occupied Heating Setpoint | Auto mode (dual setpoint) |
| `hvac_action` | Thermostat Running State | Shows active heating/cooling |
| `min_temp` / `max_temp` | Absolute Min/Max limits | Constrains setpoint range |

## Companion fan (opt-in)

Apple Home does not surface a thermostat fan or `fan_only` mode, so an AC's fan never shows up on the thermostat tile. Setting `climateExposeFan` per entity in **Entity Mapping** exposes the AC fan as its own Matter **Fan** tile bound to the same climate entity.

This only takes effect when the climate entity reports the `FAN_MODE` feature. Enabling it re-registers the AC as a composed device, which forces a one-time re-pair of that AC.

Turning the Fan tile off now sends `climate.turn_off` (it no longer flips the AC into cool/heat). Turning it on puts the AC into `fan_only`, and the tile's speed maps to `climate.set_fan_mode`.

## Forced turn on for IR ACs (opt-in)

An IR blaster only sends, it never hears back, so Home Assistant reports the last command instead of the real device state. When HA says the AC is on, the bridge skips `climate.turn_on` to keep the current HVAC mode ([#269](https://github.com/RiDDiX/home-assistant-matter-hub/issues/269)), and a physically off AC stays off.

Set `climateForceTurnOn` per entity in **Entity Mapping** to always send `climate.turn_on` on a Matter On command ([#462](https://github.com/RiDDiX/home-assistant-matter-hub/issues/462)).

## Block Off (opt-in)

Apple Home shows a power button on every Matter thermostat and has no setting to hide it. A heating-only entity becomes a Heater Cooler tile there, where the power state is a required part of the tile, so the bridge can't remove it either. On integrations where Off also stops a schedule (Wiser: `auto` is the schedule, `off` is frost protection) a single tap on the tile turns the room off.

Set `climateBlockOff` per entity in **Entity Mapping** to refuse Off from Matter controllers. The bridge answers the Off with an error and never calls Home Assistant, so the entity keeps its mode. Changing the temperature still works, and an Off set in Home Assistant or the device's own app still shows up. The option also drops the OnOff cluster like `disableClimateOnOff`, so a voice "turn off" can't switch the entity off either. On climates with fan modes (Room Air Conditioner) the power state stays visible and follows Home Assistant, and the blocked command is not sent ([#527](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/527)).

## Plain Thermostat fallback (Aqara)

A climate entity with a fan mode is exposed as a Matter **Room Air Conditioner** (0x0072). Aqara Home only knows that type since app 5.1.9 / controller firmware 4.3.5, older versions silently drop the endpoint. Set `disableClimateFanControl` in **Entity Mapping** to expose the entity as a plain **Thermostat** instead, which Aqara has long supported.

The flag only takes effect after a **full HAMH restart** (restarting just the bridge is not enough), and Aqara caches the bridge's device list, so afterwards **remove the bridge from Aqara Home and pair it again**. Skipping either step leaves the old air conditioner endpoint in place and the device stays invisible ([#318](https://github.com/RiDDiX/home-assistant-matter-hub/issues/318), [#389](https://github.com/RiDDiX/home-assistant-matter-hub/issues/389)).

## Apple Adaptive Temperature (iOS 26+, opt-in)

Apple Home's Adaptive Temperature (At Home, Away, Night, and Extended Away automatic presets) requires a standalone Matter **Thermostat** (`0x0301`) advertising Matter `Presets`, root `TimeSynchronization`, Apple `0x1349` MEI preset extensions, and an Apple-allowlisted thermostat Vendor/Product ID.

To enable it, create a bridge using the **Apple Adaptive Thermostat** template (or enable `appleAdaptiveTemperature` in **Bridge Settings → Feature Flags**) with one thermostat per bridge:

- Enabling `appleAdaptiveTemperature` implies `serverMode` and exposes the climate entity as a plain **Thermostat** (`0x0301`, disabling `FanControl` and `OnOff`), without touching non-adaptive bridges. Toggling the flag on an existing bridge requires a **full HAMH restart** and re-pairing.
- **Default pairing name (`Aqara Thermostat Hub W200`):** Because iOS 26 gates Adaptive Temperature on an allowlisted VID/PID, HAMH advertises `0x115F / 0x4801` (Aqara Thermostat Hub W200) on the root node. Apple Home pulls `"Aqara Thermostat Hub W200"` from Apple's Matter DCL catalog during the pairing wizard instead of the bridge/HA name; rename it during setup and the custom name sticks.
- **Setpoint latching:** Apple Home edits both heating and cooling bounds for all four states regardless of the current HVAC mode. HAMH persists all preset setpoints on disk and applies the relevant bound on demand when a preset activates, when you edit the active preset, or when you switch HVAC modes (`heat` ↔ `cool` ↔ `heat_cool`).
- **Disable internal schedules:** If the physical thermostat runs its own timed schedule or temporary hold timer (for example, Ecobee **Hold Duration** set to *Until next scheduled activity*), a hardware-initiated setpoint change (> ±0.6°C outside the 8 s echo window) is treated as a manual override and clears the active Apple preset. Set your thermostat's hold behavior to permanent (*Until you change it*) so Apple Home owns transitions cleanly.

## Temperature Display Unit

The `ThermostatUserInterfaceConfiguration` cluster exposes your HA temperature unit preference (°C or °F) to Matter controllers. Controllers may use this to display temperatures in your preferred unit.

## Compatibility

| Controller | Heat | Cool | Auto | Dry | Fan Only |
|------------|------|------|------|-----|----------|
| Apple Home | ✅ | ✅ | ✅ | ❌ | ❌ |
| Google Home | ✅ | ✅ | ✅ | ❌ | ❌ |
| Amazon Alexa | ✅ | ✅ | ✅ | ❌ | ❌ |

> Dry and Fan Only modes are exposed via Matter but controller support varies. Apple Home and Google Home typically only show Heat, Cool, Auto, and Off.

## Troubleshooting

### Apple Home shows Auto button but shouldn't

If your device only supports `heat` and `cool` (not `heat_cool`), HAMH intentionally does NOT expose AutoMode. If Auto still appears, check that your HA entity does not include `heat_cool` in its `hvac_modes` list (Developer Tools → States).

### Mode flipping / conflicting commands from Apple Home

This was fixed in v2.0.20. AutoMode is now only exposed when the device truly supports `heat_cool` (dual setpoint). Update to the latest version.

### Alexa rejects temperature commands

Single-capability thermostats (heat-only or cool-only) had a conformance issue with `controlSequenceOfOperation` that caused Alexa to reject commands. Fixed in v2.0.27, the sequence is now dynamically set to `CoolingOnly` or `HeatingOnly` instead of `CoolingAndHeating`.

### Current temperature shows wrong value

If `current_temperature` is `null` or unavailable, the bridge falls back to the setpoint value. Check your HA entity's `current_temperature` attribute in Developer Tools.

### Zoned AC with only heat_cool mode

Devices that report only `heat_cool` in `hvac_modes` (no explicit `heat` or `cool`) are handled since v2.0.27. The `controlSequenceOfOperation` dynamically switches between `CoolingOnly` and `HeatingOnly` based on `hvac_action`.

### Aqara Home does not show the climate device

See [Plain Thermostat fallback (Aqara)](#plain-thermostat-fallback-aqara) above. Also update HAMH to v2.0.47 or later first: v2.0.46 had a bug where a climate endpoint could fail to initialize and silently disappear from the bridge (#375).
