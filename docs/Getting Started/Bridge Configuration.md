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
> See [this guide](../Guides/Connect%20Multiple%20Fabrics.md) for details how to set this up.

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
| `regex` | Regular expression matching entity IDs. Full regex support. | `^light\.(kitchen\|bedroom)_.*` |
| `domain` | Match entities by their domain (the part before the dot). | `light`, `switch`, `sensor` |
| `platform` | Match entities by their integration/platform. | `hue`, `zwave`, `mqtt` |
| `label` | Match entities by their label slug. | `voice_control` |
| `area` | Match entities by their area slug. | `living_room` |
| `entity_category` | Match entities by their category. | `config`, `diagnostic` |
| `device_name` | Match entities by their device name (case-insensitive, supports wildcards). | `Living Room*` |

### Pattern vs Regex

**Pattern** uses simple wildcard matching:
- `*` matches any characters (zero or more)
- All other characters are matched literally
- Example: `light.living_room_*` matches `light.living_room_lamp`, `light.living_room_ceiling`

**Regex** uses full JavaScript regular expressions:
- More powerful and flexible
- Can match complex patterns
- Example: `^(light|switch)\.kitchen_.*` matches all lights and switches in the kitchen

### Device Name Filter

The `device_name` filter matches against the device's name (not the entity ID):
- Case-insensitive matching
- Supports `*` wildcard for pattern matching
- Matches against: user-defined name → device name → default name
- Example: `*Philips*` matches all devices with "Philips" in their name

The `value` property is a string containing the corresponding value. You can add multiple include or exclude rules which
are then combined.
All entities which match one of the include-rules will be included, but all entities which match one of the exclude
rules will be excluded.

Labels have to be applied at an entity level, not under device.

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

A comprehensive example using multiple filter types:

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

## Issues with labels

> [!WARNING]
>
> - Labels and areas in Home Assistant are technically represented by their "slugs".
> - Slugs are technical identifiers used in the background.
> - Slugs are always lowercase and only allow a-z and underscores, so everything else will be replaced with an `underscore`.
> - Even when renaming a label or area, the slug doesn't change. Never.
>
> You can retrieve the slug using the following templates in Home Assistant:
>
> - `{{ labels() }}` - returns all labels
> - `{{ labels("light.my_entity") }}` - returns the labels of a specific entity
> - `{{ areas() }}` - returns all areas

If you can’t get it working with your labels, you can delete your label and re-create it.
