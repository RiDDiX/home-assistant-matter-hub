# Controller Compatibility Matrix

This page documents which Matter device types work with which controllers, based on community testing and the vendors' published Matter device-type lists.

:::info
Compatibility depends on controller firmware versions. This matrix reflects the latest known state. If you find discrepancies, please open an issue.
:::

## Device Type Support

Rows flagged with a footnote number link to the vendor source that establishes the value. Rows without a number are established by community testing or by earlier releases of HAMH.

| HA Domain | Matter Device Type | Apple Home | Google Home | Alexa | Aqara Home | SmartThings |
|---|---|:---:|:---:|:---:|:---:|:---:|
| `light` | OnOffLight | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `light` | DimmableLight | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `light` | ColorTemperatureLight | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `light` | ExtendedColorLight | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `switch` | OnOffPlugInUnit | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `switch` | DimmablePlugInUnit | ✅ | ✅ | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `lock` | DoorLock | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `cover` | WindowCovering | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `climate` | Thermostat | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `fan` | Fan | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ⚠️ |
| `sensor` | TemperatureSensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `sensor` | HumiditySensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `sensor` | PressureSensor | ✅ | ✅ [¹](#sources) | ❌ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `sensor` | IlluminanceSensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ❓ | ✅ |
| `sensor` | FlowSensor | ❓ | ✅ [¹](#sources) | ❌ [²](#sources) | ❓ | ❓ |
| `sensor` | AirQualitySensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `sensor` | ElectricalSensor | ❓ | ❓ | ❓ | ❓ | ❓ |
| `binary_sensor` | ContactSensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `binary_sensor` | OccupancySensor | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `binary_sensor` | SmokeCoAlarm | ✅ | ✅ | ✅ [²](#sources) | ✅ [⁴](#sources) | ✅ |
| `binary_sensor` (override) | WaterLeakDetector | ✅ [³](#sources) | ❌ [¹](#sources) | ⚠️ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `binary_sensor` (override) | WaterFreezeDetector | ❌ [³](#sources) | ❌ [¹](#sources) | ❌ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `media_player` | Speaker | ❓ | ✅ [¹](#sources) | ❌ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `media_player` | BasicVideoPlayer | ❓ | ❓ | ❓ | ✅ [⁴](#sources) | ❓ |
| `valve` | WaterValve | ✅ | ❌ [¹](#sources) | ❌ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `vacuum` | RoboticVacuumCleaner | ✅ [³](#sources) | ✅ [¹](#sources) | ✅* [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `water_heater` | Thermostat | ✅ | ✅ | ✅ | ✅ [⁴](#sources) | ❓ |
| `alarm_control_panel` | ModeSelect | ❓ | ❓ | ❌** | ❓ | ❓ |
| `select` | ModeSelect | ❓ | ❌*** | ❌** | ❓ | ❓ |
| `event` | GenericSwitch | ✅ | ❓ | ✅ [²](#sources) | ❓ | ❓ |
| `humidifier` | Fan | ✅ | ✅ [¹](#sources) | ✅ [²](#sources) | ✅ [⁴](#sources) | ❓ |
| `dishwasher` (override) | Dishwasher | ❌ [³](#sources) | ✅ [¹](#sources) | ✅ [²](#sources) | ❓ | ✅ |
| `weather` | TemperatureSensor (+Humidity, +Pressure) | ⚠️**** | ⚠️**** | ⚠️**** | ❓ | ❓ |

:::note Leak and freeze detectors are opt-in
By default a `moisture` or `cold` binary sensor is exposed as a plain ContactSensor (Matter 1.3), which every controller handles. The WaterLeakDetector and WaterFreezeDetector rows above are Matter 1.4 types that are only used if you set the entity's Matter device type by hand in the Entity Mapping dialog. Setting WaterLeakDetector gives Apple Home (iOS 18.4+) a real leak/alarm tile, but Google does not list these types, Alexa maps water leak to no capability, and exposing a 1.4 detector type can knock out an Alexa bridge so every device on it goes unresponsive ([#365](https://github.com/RiDDiX/home-assistant-matter-hub/issues/365)). Stay on the default unless you are Apple-only.
:::

### Legend

- ✅ = Confirmed working
- ⚠️ = Partial support or known issues
- ❓ = Untested or unknown
- ❌ = Not supported by the controller

\* Alexa vacuum support requires the `vacuumOnOff` feature flag enabled.

\*\* Alexa does not support the standalone ModeSelect device type (0x0027). The ModeSelect cluster is only recognized on specific device types like Lamp or Fan. See [Alexa Supported Device Categories](https://developer.amazon.com/en-US/docs/alexa/smarthome/supported-matter-device-categories.html) and [#273](https://github.com/RiDDiX/home-assistant-matter-hub/issues/273).

\*\*\* Google Home does not support the standalone ModeSelect device type (0x0027): it is absent from Google's published Matter device types, so Google shows a generic info screen with no options control (#356). The option labels are sent correctly on the wire, this is a controller-side device-type gap, not a bridge bug. The Home Assistant Google Assistant cloud integration does expose these entities as Google "Modes", but that is a separate non-Matter path, not the HAMH bridge. Workaround: use that cloud integration, enable the per-entity "Expose as an on/off switch" mapping (maps on/off to two chosen options, works on all controllers), or expose the entity as an HA template switch or script. See [#356](https://github.com/RiDDiX/home-assistant-matter-hub/issues/356) and [#296](https://github.com/RiDDiX/home-assistant-matter-hub/issues/296).

\*\*\*\* A `weather` entity is exposed as a TemperatureSensor with Humidity and Pressure clusters stacked on one device. Temperature and Humidity should work where the standalone sensor rows do; Pressure is Google-only (see the PressureSensor row). The stacked-cluster shape on a single device is not yet community-tested, so treat these cells as expected, not confirmed.

**No switch tile over Matter.** Matter has no on/off device type that controllers render as a plain "switch": every controller shows 0x010A as a plug/outlet and 0x0100 (the OnOffSwitch override) as a light. The switch tile you may know from HA's HomeKit Bridge comes from the HomeKit-native Switch service, which has no Matter equivalent. Apple's "Show as" works on Matter outlets but only offers Outlet, Light, or Fan. The Matter 1.4 Mounted On/Off Control type (experimental override) shows as a switch on SmartThings and Aqara; Apple, Google, and Alexa don't know the type and are expected to fall back to its advertised plug subset (not yet verified on real devices). For a genuine switch tile on Apple or Google, expose that entity through HA's HomeKit Bridge or Google integration in parallel ([#380](https://github.com/RiDDiX/home-assistant-matter-hub/issues/380)).

### Sources

Footnote references for the ✅ / ❌ cells above:

1. Google Home, [Supported devices](https://developers.home.google.com/matter/supported-devices) (doc dated 2024-12-20). Rows marked ❌ for Google are device types not listed on that page. The Google doc is roughly 16 months old; a cell not listed may just mean "not yet documented".
2. Amazon Alexa, [Supported Matter Device Categories and Clusters](https://developer.amazon.com/en-US/docs/alexa/smarthome/supported-matter-device-categories.html) (doc dated 2026-04-08). Rows marked ❌ for Alexa are device types absent from that page.
3. Apple Home, [Use Matter accessories with the Home app](https://support.apple.com/en-us/102135) (doc dated 2025-12-12) plus iOS 18.4 release coverage for robot vacuum support. Apple's public doc does not list dishwashers as a supported category.
4. Aqara Home, [Everything Matter](https://www.aqara.com/en/explore/everything-matter/) device list (fetched 2026-06) plus the [April 2025 Matter controller update](https://www.businesswire.com/news/home/20250409001178/en). Aqara surfaces one of the widest device-type ranges; ❓ for Aqara means the type is not named on that page, not that it is known to fail.

Apple, Google, Alexa, Aqara, and SmartThings each move at a different cadence. A ❌ here means the vendor has not published support on their current device-type page, not that the device is known to fail. When a vendor adds the category we flip the cell and cite the update.

## Aqara Home

Aqara Home is recognized as a controller: when an Aqara fabric is commissioned, the per-device support chips and the warnings reflect the Aqara column above. These warnings show on the bridge's own page and in the Health Dashboard. Aqara surfaces a wide range of Matter device types, so it rarely warns.

A few Aqara quirks are handled for you:

- Power/energy clusters are kept off light endpoints, which Aqara would otherwise drop ([#374](https://github.com/RiDDiX/home-assistant-matter-hub/discussions/374)).
- The root `softwareVersionString` is aligned with the numeric version so bridge registration does not stall ([#316](https://github.com/RiDDiX/home-assistant-matter-hub/issues/316)).
- `productName` is stripped of characters that crash Aqara when the `productNameFromNodeLabel` flag is on ([#330](https://github.com/RiDDiX/home-assistant-matter-hub/issues/330)).

If Aqara does not show an air conditioner, set the entity's `disableClimateFanControl` flag to expose it as a plain Thermostat ([#318](https://github.com/RiDDiX/home-assistant-matter-hub/issues/318)). The flag needs a full HAMH restart to take effect, and Aqara caches the bridge's device list, so remove the bridge from Aqara Home and pair it again afterwards. Alternatively, Aqara Home app 5.1.9 with controller firmware 4.3.5 or newer knows the Room Air Conditioner type natively, so updating Aqara can make the default exposure work without the flag. For naming, the `productNameFromNodeLabel` bridge flag and the per-entity `customProductName` / `customVendorId` overrides help Aqara show the device name you expect.

## Controller Profiles

HAMH includes built-in controller profiles that pre-configure feature flags for optimal compatibility:

| Profile | Key Settings |
|---|---|
| **Apple Home** | `autoComposedDevices: true`, `autoBatteryMapping: true`, `autoHumidityMapping: true`, `autoPressureMapping: true` |
| **Google Home** | `autoForceSync: true`, `autoComposedDevices: true`, `autoBatteryMapping: true`, `autoHumidityMapping: true`, `autoPressureMapping: true` |
| **Alexa** | `autoForceSync: true`, `autoBatteryMapping: true`, `autoHumidityMapping: true`, `autoPressureMapping: true`, `coverUseHomeAssistantPercentage: true` |
| **Multi-Controller** | `autoForceSync: true`, `autoComposedDevices: true`, `autoBatteryMapping: true`, `autoHumidityMapping: true`, `autoPressureMapping: true` |

See [Bridge Configuration](../getting-started/bridge-configuration.md) for details on how to select a profile.

## Official Controller Documentation

- **Alexa**: [Matter Support](https://developer.amazon.com/en-US/docs/alexa/smarthome/matter-support.html#device-categories-and-clusters)
- **Google Home**: [Supported Devices](https://developers.home.google.com/matter/supported-devices#device_type_and_control_support)
- **Apple Home**: [Matter Accessories](https://support.apple.com/en-us/102135)
- **Aqara Home**: [Everything Matter](https://www.aqara.com/en/explore/everything-matter/)
- **SmartThings**: [Supported Device Types](https://developer.smartthings.com/docs/devices/hub-connected/matter/matter-device-types)

## Contributing

If you have tested a device type with a controller not marked above, please open an issue or PR with your findings. Include:
- Controller name and firmware version
- Device type tested
- Whether it works, partially works, or doesn't work
- Any specific issues encountered
