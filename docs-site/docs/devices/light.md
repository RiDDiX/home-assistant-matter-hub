# Light

Home Assistant lights are automatically mapped to the appropriate Matter light type based on the entity's `supported_color_modes` attribute.

## Device Type Selection

| HA Color Modes | Matter Device Type |
|----------------|-------------------|
| None / `onoff` only | OnOffLight |
| `brightness` (no color/temp) | DimmableLight |
| `color_temp` (no HS/RGB/XY) | ExtendedColorLight (ColorTemperature feature) |
| `hs`, `rgb`, `xy`, `rgbw`, `rgbww` | ExtendedColorLight (HueSaturation feature) |
| `color_temp` + any color mode | ExtendedColorLight (both features) |

> **Note:** Color-temperature-only lights use `ExtendedColorLight` internally (not `ColorTemperatureLightDevice`) to avoid Matter.js initialization issues. The behavior is identical, controllers still show a color temperature slider.

## Features

- **On/Off**, Power control via `light.turn_on` / `light.turn_off`
- **Brightness**, HA brightness (0-255) mapped to Matter Level (0-254)
- **Color Temperature**, HA mireds/Kelvin mapped to Matter Color Temperature. Min/max range taken from `min_color_temp_kelvin` / `max_color_temp_kelvin` attributes
- **Color (Hue/Saturation)**, HA `hs_color`, `rgb_color`, `xy_color`, `rgbw_color`, or `rgbww_color` converted to Matter Hue/Saturation
- **Battery**, Optional battery level from entity attribute or mapped sensor
- **Adaptive Lighting**, Color changes while light is off are staged and merged on turn-on (`executeIfOff` + `pendingColorStaging`)

## Power & Energy Measurement

Lights can optionally report electrical power and energy consumption via Matter clusters:

- **Manual mapping** via Entity Mapping UI: `powerEntity`, `energyEntity`

Lights no longer pick up power/energy sensors automatically. Electrical clusters on a light endpoint break Aqara, so a light that previously showed an energy readout may drop it after upgrading. Re-add it by setting `powerEntity` / `energyEntity` explicitly on that light in the Entity Mapping dialog (#374).

## Entity Mapping Options

| Option | Description |
|--------|-------------|
| `batteryEntity` | Battery sensor entity ID (auto-detected or manual) |
| `powerEntity` | Power measurement sensor entity ID (manual only, not auto-mapped for lights, see #374) |
| `energyEntity` | Energy measurement sensor entity ID (manual only, not auto-mapped for lights, see #374) |

## Color Conversion

The bridge converts between HA and Matter color formats:

| HA Attribute | Conversion |
|-------------|------------|
| `hs_color` | Direct HS → Matter Hue/Saturation |
| `rgb_color` | RGB → HS → Matter |
| `xy_color` | XY → HS → Matter |
| `rgbw_color` | RGBW → HS → Matter |
| `rgbww_color` | RGBWW → HS → Matter |

When setting color from a controller, Matter Hue/Saturation is converted back to HA `hs_color` format.

## Compatibility

| Controller | On/Off | Brightness | Color Temp | Full Color |
|------------|--------|------------|------------|------------|
| Apple Home | ✅ | ✅ | ✅ | ✅ |
| Google Home | ✅ | ✅ | ✅ | ✅ |
| Amazon Alexa | ✅ | ✅ | ✅ | ✅ |

## Troubleshooting

### Light turns on at 100% brightness (Google Home)

After a subscription renewal (~5 minutes), Google Home may set brightness to 100% when turning on a light. This is a Google Home behavior, not a bridge issue. See [Supported Device Types](../supported-device-types.md#light-brightness-reset-after-extended-off-period) for a Home Assistant Blueprint workaround.

### Light turns on at 100% brightness (Alexa)

Alexa may send an explicit `moveToLevel(254)` after turning on a light following subscription renewal. There is currently no bridge-side workaround for this Alexa behavior.

### Color temperature range differs

Matter and HA may have different min/max color temperature ranges. The bridge uses the entity's `min_color_temp_kelvin` and `max_color_temp_kelvin` attributes. If your controller shows a different range, check these attributes in HA Developer Tools.

### Battery level not showing

1. Ensure the entity has a `battery` or `battery_level` attribute, or configure `batteryEntity` in Entity Mapping
2. The battery sensor must return a numeric 0-100 value
3. You may need to remove and re-add the device in your controller after enabling battery support
