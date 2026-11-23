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
- `shutter` (with tilt it is exposed as an exterior venetian blind, Matter 1.6.1 allows the Shutter type only on one axis)
- `awning`
- `window` (Velux-style motorized windows; mapped to lift-only Rollershade)
- `garage` (limited support)

Covers without a device class or with unsupported classes are still exposed as generic WindowCovering devices.

## Feature Flags

These flags are configured in **Bridge Settings** and apply to all covers on that bridge:

| Flag | Description |
|------|-------------|
| `coverUseHomeAssistantPercentage` | The controller shows the same number as Home Assistant, so HA 80% open shows as 80. A request for exactly 0% is sent as open and exactly 100% as close, because Alexa sends its spoken "open" and "close" that way. Open and close commands are not swapped. Use this for Alexa. **Not Matter compliant.** |
| `coverDoNotInvertPercentage` | Same effect on the numbers as `coverUseHomeAssistantPercentage`, kept for older setups. Open and close commands are not swapped. **Not Matter compliant.** |
| `coverSwapOpenClose` | At bridge level it swaps the open and close commands for all covers on the bridge and also reports the Home Assistant numbers. Set it per cover in the Entity Mapping dialog to swap only open/close and leave the percentage alone (see [#406 below](#cover-swap-406)). |

## Percentage Mapping

Matter and Home Assistant use opposite percentage conventions:

| Percentage | HA Meaning | Matter Meaning |
|-----------|------------|----------------|
| 0% | Fully closed | Fully open |
| 100% | Fully open | Fully closed |

By default, HAMH inverts the percentage to comply with the Matter specification. Use the feature flags above if your setup requires different behavior.

The position chip on the device cards in the HAMH web UI always shows percent open, like Home Assistant, whichever flags are set. With the default inversion a cover at 80% shows as "80% open" there while Alexa shows 20.

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

Enable `coverSwapOpenClose` on the cover itself in the Entity Mapping dialog. It swaps only open and close and leaves the percentage alone (see [#406 below](#cover-swap-406)). The bridge-wide `coverSwapOpenClose` flag swaps the commands for every cover on the bridge and also changes the reported percentage to the Home Assistant number.

### Alexa: open/close right but "set to a percentage" inverted (#406) {#cover-swap-406}

Alexa sends everything as a lift percentage: open/close hit the 0/100% ends, "set to N%" hits the middle, and Alexa uses opposite polarity for the two. The bridge-level `coverSwapOpenClose` also un-inverts the percentage, so turning it on fixes open/close but flips set-position (off is the reverse), and no single bridge setting gets both right.

Fix: enable `coverSwapOpenClose` on the cover itself in the Entity Mapping dialog and leave the bridge-level flag off. Per cover it swaps only open/close and keeps the default percentage inversion, so open, close and set-to-N% all come out correct. One catch: saying "set to exactly 0%" or "100%" still counts as open/close. For a cover without position support, a mid-range percent goes to the same end a position cover would.

### Close while opening only stops the cover (#512) {#cover-open-close-as-position-512}

Some integrations, for example [Cover Time Based](https://github.com/Sese-Schneider/ha-cover-time-based), stop when they get `open_cover` or `close_cover` while the cover is moving, and only reverse on `set_cover_position`. Alexa sends "open" and "close" as the 0% and 100% lift ends, which HAMH turns into `open_cover` / `close_cover`, so "close" during an opening move just stops it.

Fix: turn on **Send open/close as position** (`coverOpenCloseAsPosition`) on that cover in the Entity Mapping dialog. Open and close then go out as `set_cover_position` 100 and 0, from every controller, and the swap setting still applies. Covers without `set_position` keep open/close. Note that a cover already at the end gets no extra open/close, so integrations that resync on a repeated open/close will not do that here. On a cover group, turn it on only if every member handles a position at its ends.

### Percentage shows wrong value in Alexa {#alexa-percentage}

Alexa shows and sends the raw Matter number. With the default inversion a cover at 80% in Home Assistant shows as 20 in Alexa, and "set to 25%" moves it to 75%. To make the numbers match:

1. Open the bridge that is paired with Alexa and choose **Edit** in its menu.
2. In **Feature Flags**, turn on **Use Home Assistant Percentage for Covers** (`coverUseHomeAssistantPercentage`).
3. Leave both swap options off, the bridge flag `coverSwapOpenClose` and the per-cover swap in the Entity Mapping dialog.
4. Save. The reported positions change right away, no restart needed.

If Alexa still shows the old number, move the cover once or let Alexa rediscover devices. The Alexa controller profile and the Alexa bridge template only set this flag on a bridge created with them. Picking them later does not change an existing bridge.

With the flag on, exactly 0% still opens the cover and exactly 100% closes it, because Alexa sends its spoken "open" and "close" as 0% and 100% (#240). Any other percentage goes to Home Assistant as is.

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
