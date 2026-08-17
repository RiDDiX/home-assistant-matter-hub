# Cover / Window Covering

Home Assistant `cover` entities are mapped to Matter **WindowCovering** devices with position and tilt control.

## Features

| HA Feature | Matter Capability |
|------------|------------------|
| `open` / `close` | Open/Close commands |
| `set_position` | Lift percentage (0-100%) |
| `set_tilt_position` | Tilt percentage (0-100%) |
| `stop` | Stop movement |

## Supported Device Classes

The following `device_class` values are supported:

- `blind`
- `curtain`
- `shade`
- `shutter`
- `awning`
- `window` (Velux-style motorized windows; mapped to lift-only Rollershade)
- `garage` (limited support)

Covers without a device class or with unsupported classes are still exposed as generic WindowCovering devices.

## Feature Flags

These flags are configured in **Bridge Settings** and apply to all covers on that bridge:

| Flag | Description |
|------|-------------|
| `coverDoNotInvertPercentage` | Skip percentage inversion. By default, HAMH inverts the percentage to match the Matter spec (0% = fully open, 100% = fully closed). Enable this if your cover already uses the Matter convention. **Not Matter compliant** when disabled. |
| `coverUseHomeAssistantPercentage` | Display HA percentages directly in Matter without conversion. Useful for Alexa where percentage display may be confusing otherwise. |
| `coverSwapOpenClose` | Swap open and close commands. Fixes reversed commands from Alexa where "open" closes the cover and vice versa. At bridge level it also un-inverts the position percentage. Set it per cover in the Entity Mapping dialog to swap only open/close and leave the percentage alone (see [#406 below](#cover-swap-406)). |

## Percentage Mapping

Matter and Home Assistant use opposite percentage conventions:

| Percentage | HA Meaning | Matter Meaning |
|-----------|------------|----------------|
| 0% | Fully closed | Fully open |
| 100% | Fully open | Fully closed |

By default, HAMH inverts the percentage to comply with the Matter specification. Use the feature flags above if your setup requires different behavior.

## Compatibility

| Controller | Open/Close | Position | Tilt | Stop |
|------------|-----------|----------|------|------|
| Apple Home | ✅ | ✅ | ✅ | ✅ |
| Google Home | ✅ | ✅ | ⚠️ | ✅ |
| Amazon Alexa | ✅ | ✅ | ❌ | ✅ |

> Tilt support varies by controller. Apple Home has the best tilt control support. Alexa maps Matter covers to open/close/position only and offers no tilt control at all, whatever the bridge advertises (#405). Control the slats from Home Assistant instead.

## Troubleshooting

### Alexa stopped controlling the cover

Around June 2026 Alexa shows the cover and its live position, but the slider and voice commands answer "device not responding". A DEBUG log shows no `handleMovement` line, so the command never reaches the bridge, Alexa just stopped sending WindowCovering writes ([#372](https://github.com/RiDDiX/home-assistant-matter-hub/issues/372)).

Workaround: set `coverExposeAsDimmableLight` per cover in the Entity Mapping dialog. Alexa still drives lights, so on/off maps to open/close and the 1-100% level maps to position. Turn it on for the covers you run from Alexa and re-add them in Alexa once.

- Keep it off if you also use Apple Home or Google Home, they handle covers fine.
- Don't put these covers in an Alexa room, or a room-wide "lights off" closes them too.
- No stop command as a light, only on/off and position.
- It is temporary. Once Alexa handles covers again, turn the option off, remove the light devices in Alexa, restart the bridge, and let Alexa rediscover.

### Alexa commands are reversed (open → close)

Enable the `coverSwapOpenClose` feature flag in your bridge settings. This is a known Alexa behavior where the open/close direction is reversed for Matter WindowCovering devices.

### Alexa: open/close right but "set to a percentage" inverted (#406) {#cover-swap-406}

Alexa sends everything as a lift percentage: open/close hit the 0/100% ends, "set to N%" hits the middle, and Alexa uses opposite polarity for the two. The bridge-level `coverSwapOpenClose` also un-inverts the percentage, so turning it on fixes open/close but flips set-position (off is the reverse), and no single bridge setting gets both right.

Fix: enable `coverSwapOpenClose` on the cover itself in the Entity Mapping dialog and leave the bridge-level flag off. Per cover it swaps only open/close and keeps the default percentage inversion, so open, close and set-to-N% all come out correct. One catch: saying "set to exactly 0%" or "100%" still counts as open/close.

### Percentage shows wrong value in Alexa

Try enabling `coverUseHomeAssistantPercentage` in bridge settings. Alexa may interpret the Matter percentage differently than other controllers.

### Cover cannot be used in Google Home Automations

Google Home does not support WindowCovering devices as actions in Automations. When selecting a cover, "no actions available" is shown. This is a Google Home limitation that also affects native Matter blinds.

**Workarounds:**
1. Use Google Home Routines with voice commands ("Hey Google, close [cover name]")
2. Create Home Assistant scripts and expose them as switches via HAMH
3. Use Home Assistant automations instead

### Cover cannot be used in Alexa routines

Alexa does not offer Matter WindowCovering devices as actions in its routine builder. The covers appear in the Alexa device list, respond to manual open/close and to voice, and accept position commands over Matter, they are simply not selectable when building a routine. Reporters have confirmed this across Rollershade, Drapery and Shutter types, and Alexa's own routine category does list covers that reach it through a skill instead of Matter, so the line is Matter versus skill on Amazon's side. No `device_class` or Matter type change makes the cover routine-selectable (#312).

**Workarounds:**
1. Set `coverExposeAsDimmableLight` on that cover in the Entity Mapping dialog. It is exposed as a dimmable light instead, where on/off is open/close and brightness is position, and lights are selectable in routines. Alexa caches the device type, so re-add the device in Alexa afterwards.
2. Wrap the cover in a Home Assistant script or scene and expose that to Alexa, scripts and scenes do show up as routine actions.
3. Use Home Assistant automations instead of Alexa routines.
4. Voice control still works ("Alexa, close the blinds"), only the routine builder is affected.

### Cover doesn't appear in Alexa routine picker after changing `device_class`

Matter `Type` and `EndProductType` are spec-defined as fixed attributes, controllers cache them at commissioning and don't re-read after that. So changing `device_class` in HA doesn't move the cover into a different Alexa sub-category (`Tapparelle interne`, `Tendine`, `Tende`, `Tende da sole`, etc.) on its own. After fixing `device_class`, restart HAMH and remove + re-add the bridge in the Alexa app so Alexa picks up the new type. This re-categorizes the device for the device list and manual control; it does not make covers available as routine actions, which is a separate Alexa limitation (see above).

### Position not updating

Check that your HA entity reports `current_position` correctly in Developer Tools → States. Some cover integrations don't report position during movement, the position will update once movement stops.

### Garage door limitations

Garage doors are exposed as WindowCovering devices since Matter does not have a dedicated garage door device type. Not all controllers handle this well. Consider using a `switch` entity with Entity Mapping override instead if you only need open/close control.
