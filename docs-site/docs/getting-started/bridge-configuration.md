# Bridge Configuration

Using the User Interface you can set up multiple bridges and configure each to use different filters for your entities.
Each bridge will be completely independent of the others and uses its own port for matter.

## Quick Start with Bridge Wizard

The easiest way to create bridges is using the **Bridge Wizard**:

1. Open the web UI and go to the Bridges page
2. Click the **Wizard** button in the top right
3. Follow the guided steps:
   - Enter a name for your bridge
   - Configure entity filters (by area, label, domain, etc.)
   - Port is automatically assigned (starting from 5540)
4. Add multiple bridges in one session
5. Review and confirm to create all bridges

The wizard automatically handles port assignment and prevents conflicts.

## Manual Configuration

You can access the bridge configuration by opening the web UI:

- If you are running the Home Assistant Add On: click on `Open Web UI`
- If you are running the docker container: open `host-ip:port` (default port is 8482 if you didn't change it)

> [!NOTE]
> You can use **one** bridge to connect to **multiple** controllers.
> See [this guide](../guides/connect-multiple-fabrics.md) for details how to set this up.

> [!WARNING]
> Alexa only supports port `5540`. Therefore, you cannot create multiple bridges to connect with Alexa.
> 
> There are users who managed to get it work using the following approach:
> 1. Create a bridge with port 5540
> 2. Connect your Alexa with that bridge
> 3. Change the port of the bridge
> 4. Verify if it is still working
> 5. Repeat for the next bridge

Every bridge has to have a `name` (string), `port` (number) and `filter` (object) property. The filter property has to
include an `include` (array) and an `exclude` (array) property.

```json
{
  "name": "My Hub",
  "port": 5540,
  "filter": {
    "include": [],
    "exclude": []
  }
}
```

A include- or exclude-item is an object having a `type` and a `value` property.

## Filter Types

| Type | Description | Example Value |
|------|-------------|---------------|
| `pattern` | Wildcard pattern matching entity IDs. Use `*` as wildcard. | `light.living_room_*` |
| `regex` | Regex tested against entity IDs only. For labels use `entity_label_regex` / `device_label_regex`. | `^light\.(kitchen\|bedroom)_.*` |
| `domain` | Match entities by their domain (the part before the dot). | `light`, `switch`, `sensor` |
| `platform` | Match entities by their integration/platform. | `hue`, `zwave`, `mqtt` |
| `entity_label` | Match entities by their label. Accepts display name or slug. Only checks entity-level labels. | `Voice Control` |
| `device_label` | Match entities by their parent device's label. All entities of that device match. | `smart_home` |
| `entity_label_regex` | Regex tested against entity-label slugs and display names. | `^(matter\|voice).*` |
| `device_label_regex` | Regex tested against device-label slugs and display names. All entities of a matching device are included. | `^(matter\|voice).*` |
| `any_field_regex` | One regex tested against a single-line haystack of all entity fields. Use lookaheads for AND, alternation for OR. | see below |
| `area` | Match entities by their area slug. | `living_room` |
| `entity_category` | Match entities by their category. | `config`, `diagnostic` |
| `device_name` | Match entities by their device name (case-insensitive, wildcards). | `Living Room*` |
| `product_name` | Match entities by their product/model name (case-insensitive, wildcards). | `Hue Color Bulb` |
| `manufacturer` | Match entities by their device manufacturer (case-insensitive, wildcards). Handy for MQTT or other generic integrations. | `*Sonoff*` |
| `device_class` | Match entities by their device class attribute. | `temperature`, `motion` |

> [!NOTE]
> The dropdown in the web UI now shows **tooltips** with detailed descriptions when hovering over each filter type.

> [!WARNING]
> The old `label` filter type is **deprecated**, use `entity_label` or `device_label` instead for clarity.

### Pattern vs Regex

**Pattern** uses simple wildcard matching:
- `*` matches any characters (zero or more)
- Example: `light.living_room_*` matches `light.living_room_lamp`

**Regex** uses full JavaScript regular expressions:
- More powerful for complex patterns
- Example: `^(light|switch)\.kitchen_.*` matches kitchen lights and switches

### Any Field Regex

`any_field_regex` runs one regex against a single-line haystack built per entity, with fields joined by spaces:

```
entity_id=... domain=... platform=... area=... entity_category=... device_class=... entity_labels=slug1,slug2 entity_label_names=Display 1,Display 2 device_labels=slug1 device_label_names=Display 1 device_name=... product_name=... manufacturer=...
```

To express AND, stack lookaheads. To express OR, use alternation. Example: include lights in the `living_room` area **or** switches carrying the `voice` label:

```
(?=.*\bdomain=light\b)(?=.*\barea=living_room\b)|(?=.*\bdomain=switch\b)(?=.*\bentity_labels=.*\bvoice\b)
```

`\b` anchors keep `domain=light` from matching `domain=lightning`. The same matcher also works in the `exclude` list, just give it the inverse pattern.

### Device Name Filter

The `device_name` filter matches against the device's name (not the entity ID):
- Case-insensitive matching
- Supports `*` wildcard for pattern matching
- Matches against: user-defined name → device name → default name
- Example: `*Philips*` matches all devices with "Philips" in their name

### Product Name Filter

The `product_name` filter matches against the device's model or product name:
- Case-insensitive matching
- Supports `*` wildcard for pattern matching
- Matches against: model → default model
- Example: `Hue*Bulb` matches all devices with a model name containing "Hue" and "Bulb"

### Device Class Filter

The `device_class` filter matches against the entity's `device_class` attribute:
- Exact match (case-sensitive)
- Common device classes: `temperature`, `humidity`, `motion`, `door`, `window`, `battery`, `power`, `energy`, `illuminance`, `pressure`
- Example: `temperature` matches all entities with `device_class: temperature`

The `value` property is a string containing the corresponding value. You can add multiple include or exclude rules which
are then combined.
All entities which match one of the include-rules will be included, but all entities which match one of the exclude
rules will be excluded.

Labels can be applied at the entity level or at the device level:
- Use `entity_label` to match labels assigned directly to entities
- Use `device_label` to match labels assigned to the parent device (all entities of that device will match)
- The old `label` type still works but only matches entity labels, use the new types for explicit control

You can use either the **display name** (e.g. `My Smart Lights`) or the **slug** (e.g. `my_smart_lights`) as the filter value. The display name is automatically resolved to the correct slug.

> [!TIP]
> Use the **Filter Reference** page in the web UI to browse all available filter values (domains, platforms, entity categories, device classes, device names, product names, labels, and areas) with click-to-copy functionality.

> [!WARNING]
> When performing changes on entities, like adding or removing a label, you need to refresh the matter-hub application
> for the changes to take effect (e.g. edit the bridge or restart the addon).

## Examples

### Basic Configuration

```json
{
  "name": "My Hub",
  "port": 5540,
  "filter": {
    "include": [
      {
        "type": "label",
        "value": "my_voice_assist"
      },
      {
        "type": "pattern",
        "value": "light.awesome*"
      }
    ],
    "exclude": [
      {
        "type": "platform",
        "value": "hue"
      },
      {
        "type": "domain",
        "value": "fan"
      },
      {
        "type": "entity_category",
        "value": "diagnostic"
      }
    ]
  }
}
```

### Using Regex for Complex Matching

Match all lights and switches that start with "kitchen" or "living_room":

```json
{
  "name": "Main Rooms",
  "port": 5540,
  "filter": {
    "include": [
      {
        "type": "regex",
        "value": "^(light|switch)\\.(kitchen|living_room)_.*"
      }
    ],
    "exclude": []
  }
}
```

### Using Device Name Filter

Include all entities from Philips devices, exclude IKEA devices:

```json
{
  "name": "Brand Filter",
  "port": 5541,
  "filter": {
    "include": [
      {
        "type": "device_name",
        "value": "*Philips*"
      }
    ],
    "exclude": [
      {
        "type": "device_name",
        "value": "*IKEA*"
      }
    ]
  }
}
```

### Combining Multiple Filter Types

A bigger example using multiple filter types:

```json
{
  "name": "Living Room Hub",
  "port": 5542,
  "filter": {
    "include": [
      {
        "type": "area",
        "value": "living_room"
      },
      {
        "type": "label",
        "value": "voice_control"
      },
      {
        "type": "pattern",
        "value": "light.guest_*"
      }
    ],
    "exclude": [
      {
        "type": "entity_category",
        "value": "diagnostic"
      },
      {
        "type": "entity_category",
        "value": "config"
      },
      {
        "type": "regex",
        "value": ".*_battery$"
      },
      {
        "type": "device_name",
        "value": "*Test*"
      }
    ]
  }
}
```

This configuration:
- **Includes**: All entities in the "living_room" area, entities with the "voice_control" label, and all lights starting with "guest_"
- **Excludes**: Diagnostic and config entities, any entity ending with "_battery", and any device with "Test" in its name

## Feature Flags

Feature flags control advanced behavior of the bridge. Configure them in the **Bridge Settings → Feature Flags** section of the web UI.

> [!WARNING]
> **autoComposedDevices is a BREAKING CHANGE**: Enabling this flag changes the Matter endpoint structure for temperature sensors with auto-mapped humidity/pressure. Controllers will see these as **new devices** and you'll need to re-assign rooms, routines, and voice aliases. Only enable for new bridges or be prepared to reconfigure.

| Feature Flag | Description | Default |
|--------------|-------------|---------|
| `autoComposedDevices` | Master toggle: combines related entities (battery, humidity, pressure, power, energy) into single Matter endpoints. **WARNING: Breaking change - see above.** | `false` |
| `autoBatteryMapping` | Automatically combines battery sensors with their parent device | `false` |
| `autoHumidityMapping` | Automatically combines humidity sensors with temperature sensors | `true` |
| `autoPressureMapping` | Automatically combines pressure sensors with temperature sensors | `true` |
| `autoForceSync` | Periodically push all device states to controllers every 90 seconds. Enable if devices get out of sync. | `false` |
| `coverSwapOpenClose` | Swap open/close commands for covers (fixes reversed Alexa commands) | `false` |
| `coverDoNotInvertPercentage` | Skip percentage inversion for covers (not Matter-compliant) | `false` |
| `coverUseHomeAssistantPercentage` | Use HA percentages directly (Alexa-friendly) | `false` |
| `includeHiddenEntities` | Include entities marked as hidden in Home Assistant | `false` |
| `serverMode` | Expose device as standalone Matter device (required for Robot Vacuums with Apple Home/Alexa). Only ONE device per bridge! | `false` |
| `productNameFromNodeLabel` | Report the node label (custom name / friendly name / entity id) as Matter `productName`. Useful for Aqara controllers that show productName as the device name. A per-entity `customProductName` still wins. | `false` |
| `preferEntityRegistryName` | Use the entity registry name (or `original_name`) as `nodeLabel` instead of the composed `friendly_name`. HA 2026.4 prefixes `friendly_name` with the device name, breaking voice commands that relied on the short entity name. `customName` still wins. | `false` |
| `fanRestorePercentOnTurnOn` | Restore the fan's previous speed when turned on instead of defaulting to 100%. Apple Home resets fans to 100% on every turn-on because the bridge must report 0% while the fan is off. Enable on Apple Home bridges. | `false` |
| `vacuumOnOff` | Add OnOff cluster to vacuum endpoints. Required for Alexa discovery. In Server Mode, enabled by default unless explicitly set to `false`. In Bridge Mode, disabled by default. | (see description) |
| `vacuumIncludeUnnamedRooms` | Include rooms without names in vacuum room selection | `false` |

## Issues with labels

> [!NOTE]
>
> You can use the label's **display name** (as shown in Home Assistant) directly as the filter value.
> For example, if your label is called "My Smart Lights", you can enter `My Smart Lights` as the value, it will be resolved automatically.
>
> If you prefer, you can still use the **slug** (e.g. `my_smart_lights`). Slugs are always lowercase and use underscores instead of spaces.

> [!WARNING]
>
> - If you renamed a label in Home Assistant, the slug does **not** change. In that case, use the current display name or the original slug.
> - Areas work differently, they still require the slug (e.g. `living_room`, not `Living Room`).
>
> You can retrieve slugs using the following templates in Home Assistant:
>
> - `{{ labels() }}` - returns all labels
> - `{{ labels("light.my_entity") }}` - returns the labels of a specific entity
> - `{{ areas() }}` - returns all areas

If you can't get it working with your labels, you can delete your label and re-create it.
