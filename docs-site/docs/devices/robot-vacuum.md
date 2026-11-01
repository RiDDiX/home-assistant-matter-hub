# Robot Vacuum

Robot vacuums are exposed as Matter **Robotic Vacuum Cleaner** devices with the following capabilities:

- **On/Off** - Start and stop cleaning
- **RVC Operational State** - Current state (idle, running, docked, error)
- **RVC Run Mode** - Cleaning modes including room-specific cleaning
- **Service Area** - Room selection for Apple Home (Matter 1.4), with multi-floor map support
- **RVC Clean Mode** - Cleaning type selection (Sweeping, Mopping, etc.) with fan speed and mop intensity
- **Power Source** - Battery level and charging state (if available)
- **Identify** - "Play Sound" in Apple Home triggers `vacuum.locate` to find your robot (v2.0.27+)

## Server Mode (Required for Apple Home & Alexa)

:::warning
**Apple Home and Alexa do not properly support bridged robot vacuums.** They require the vacuum to appear as a **standalone Matter device**, not as part of a bridge.

If your vacuum shows "Updating" in Apple Home, doesn't respond to Siri commands, or isn't discovered by Alexa, you **must** use **Server Mode**.
:::

### What is Server Mode?

Server Mode exposes a single device as a **standalone Matter device** instead of a bridged device. This is required because:

- Apple Home doesn't support Siri voice commands for bridged RVCs
- Alexa doesn't discover bridged RVCs at all
- The vacuum shows "Updating" or "Not Responding" in Apple Home

### How to Enable Server Mode

1. **Create a new bridge** in the Matter Hub web interface
2. **Enable "Server Mode"** checkbox in the bridge creation wizard
3. Add **your vacuum** to this bridge (best kept alone on its node)
4. **Pair the new bridge** with Apple Home or Alexa
5. Your other devices stay on your regular bridge(s)

:::note
Server Mode nodes carry up to **10 devices**; the first entity is the primary and drives the node name and type. Running more than one device per node is experimental, see [Standalone Devices](../getting-started/standalone-devices.md). For a vacuum it is still best to keep it alone on its node.
:::

### After Enabling Server Mode

- Your vacuum will appear as a native Matter device (not bridged)
- Siri voice commands like "Hey Siri, start the vacuum" will work
- Alexa will discover and control the vacuum
- Room selection via Service Area will work in Apple Home

---

## Cleaning Modes

The RVC Clean Mode cluster allows selecting the cleaning type. This is auto-enabled for Dreame and Ecovacs vacuums, and can be manually configured for other brands (including Roborock).

### Supported Cleaning Modes

| Mode | Matter Tag | Description |
|------|-----------|-------------|
| Vacuum | Vacuum | Dry vacuum only |
| Mop | Mop | Wet mop only |
| Vacuum & Mop | Vacuum + Mop | Vacuum and mop simultaneously |
| Vacuum Then Mop | DeepClean + Vacuum + Mop | Vacuum first, then mop (Apple Home shows as "Deep Clean") |

Matter needs at least two cleaning modes. A vacuum with nothing to choose gets an extra "Auto" mode next to Vacuum. Picking it is refused and nothing reaches Home Assistant. Apple Home lists it as "Automatic".

:::note
**Fallback behavior (v2.0.26+):** If your cleaning mode entity doesn't have a dedicated "Vacuum Then Mop" option, HAMH automatically falls back to the "Vacuum & Mop" option. So you only need `vacuum`, `mop`, and `vacuum_and_mop` in your cleaning mode entity.
:::

### Auto-Detection (Dreame, Ecovacs)

For Dreame vacuums, the cleaning mode entity is automatically derived from the vacuum entity ID:
- `vacuum.r2d2` → `select.r2d2_cleaning_mode`

For Ecovacs, cleaning mode entities are auto-detected by naming pattern (`*cleaning_mode*`).

No manual configuration is needed unless the entity naming differs.

### Manual Configuration (Ecovacs, Roborock, Others)

For vacuums where the cleaning mode entity can't be auto-detected, you need to configure it manually:

1. Go to your **bridge settings** → **Entity Mappings**
2. **Edit your vacuum entity** (e.g., `vacuum.t20_omni`)
3. Set **Cleaning Mode Entity** to the select entity that controls the cleaning mode
4. Changes take effect automatically within ~30 seconds

:::tip
To find the correct select entity, look in Home Assistant for a `select.*` entity belonging to your vacuum device that has options like "Vacuum", "Mop", "Vacuum and mop", etc. The naming varies by brand and language.
:::

### Creating a Cleaning Mode Helper (Roborock & Others)

Some integrations **do not expose a cleaning mode select entity**. Without one, HAMH cannot switch between vacuum, mop, and vacuum+mop modes. The official Roborock integration adds a `Cleaning mode` select since Home Assistant 2026.8. HAMH detects it when its entity ID contains `cleaning_mode`, otherwise set it as the Cleaning Mode Entity. On older Home Assistant versions, create a helper as shown below.

You can create one yourself using Home Assistant helpers and automations:

#### Step 1: Create an Input Select Helper

Go to **Settings → Devices & Services → Helpers → Create Helper → Dropdown** and create:

- **Name:** Roborock Cleaning Mode Store
- **Entity ID:** `input_select.roborock_cleaning_mode_store`
- **Options:** `vacuum`, `mop`, `vacuum_and_mop`

#### Step 2: Create a Template Select Entity

Add this to your Home Assistant `configuration.yaml` (or a separate template file):

```yaml
template:
  - select:
      - name: "Roborock Cleaning Mode"
        unique_id: roborock_cleaning_mode_hamh
        icon: mdi:robot-vacuum
        state: "{{ states('input_select.roborock_cleaning_mode_store') }}"
        availability: >
          {{ states('input_select.roborock_cleaning_mode_store') not in ['unknown','unavailable'] }}
        options: >
          {{ ['vacuum', 'mop', 'vacuum_and_mop'] }}
        select_option:
          - service: input_select.select_option
            target:
              entity_id: input_select.roborock_cleaning_mode_store
            data:
              option: "{{ option }}"
```

#### Step 3: Create an Automation to Apply Settings

This automation watches your cleaning mode store and applies the correct fan speed and mop intensity settings when the mode changes:

```yaml
alias: "Roborock - Apply Cleaning Mode"
triggers:
  - entity_id: input_select.roborock_cleaning_mode_store
    trigger: state
actions:
  - choose:
      - conditions:
          - condition: state
            entity_id: input_select.roborock_cleaning_mode_store
            state: vacuum
        sequence:
          - action: vacuum.set_fan_speed
            target:
              entity_id: vacuum.roborock_s7_maxv
            data:
              fan_speed: balanced
          - action: select.select_option
            target:
              entity_id: select.roborock_s7_maxv_mop_intensity
            data:
              option: "off"
      - conditions:
          - condition: state
            entity_id: input_select.roborock_cleaning_mode_store
            state: mop
        sequence:
          - action: vacuum.set_fan_speed
            target:
              entity_id: vacuum.roborock_s7_maxv
            data:
              fan_speed: "off"
          - action: select.select_option
            target:
              entity_id: select.roborock_s7_maxv_mop_intensity
            data:
              option: mild
      - conditions:
          - condition: state
            entity_id: input_select.roborock_cleaning_mode_store
            state: vacuum_and_mop
        sequence:
          - action: vacuum.set_fan_speed
            target:
              entity_id: vacuum.roborock_s7_maxv
            data:
              fan_speed: balanced
          - action: select.select_option
            target:
              entity_id: select.roborock_s7_maxv_mop_intensity
            data:
              option: mild
```

:::note
Replace `vacuum.roborock_s7_maxv` and `select.roborock_s7_maxv_mop_intensity` with your actual entity IDs. Adjust the fan speed and mop intensity values to match your vacuum's available options.
:::

#### Step 4: Configure in HAMH

1. Go to **Entity Mappings** → Edit your vacuum
2. Set **Cleaning Mode Entity** to `select.roborock_cleaning_mode_hamh` (the template select)
3. Set **Mop Intensity Entity** to `select.roborock_s7_maxv_mop_intensity`

After this setup, Apple Home will show Vacuum, Mop, Vacuum & Mop, and Deep Clean (Vacuum Then Mop) as cleaning modes. The automation will apply the correct settings when you switch modes.

---

## Suction Level / Fan Speed (Apple Home Intensity Options)

When your vacuum has fan speed options, HAMH creates extra intensity modes. Apple Home can show them under the Vacuum cleaning type according to the semantic tags it recognizes.

### Auto-Detection

Fan speed support is **automatically detected** from the vacuum's `fan_speed_list` attribute. No manual configuration is needed.

### Apple Home Labels and Automatic Tag Selection

HAMH's default automatic fan mapping uses **Quiet**, **Automatic**, and **Max**.
This is not a three-option limit in Apple Home. Mode IDs and labels alone do
not guarantee separate Home choices; the semantic mode tags matter. To avoid
ambiguous choices, this mapping selects one automatic representative per tag:

| Intensity | Preferred automatic representative |
|-----------|------------------------------------|
| Quiet | quiet, then silent, otherwise the first matching quiet alias |
| Automatic | auto, then balanced, then normal, otherwise the first matching alias |
| Max | max_plus, then max+, max, turbo, otherwise the first matching strong alias |

Only one fan speed gets each intensity tag, whatever the order of the list or
extra off/custom options. All fan speeds keep their mode and the Vacuum tag, so
the current mode is still reported when the robot runs one of the others (for
example Turbo or Gentle). Apple Home may not offer those other speeds as a
choice.

:::note
Earlier versions gave every matching speed the tag. Some speeds now lose it, for
example Dreame `strong` (Max goes to `turbo`), Ecovacs and Roborock `max` (Max
goes to `max_plus`) and Roborock `medium`/`gentle`. A saved Custom Tag Mapping
now takes its tag away from the automatic match instead of adding a second one.
Use a Custom Tag Mapping to choose which speed Apple Home uses for a bucket.
:::

Additional standard tags include **Min (6)** for the lowest available setting
and **DeepClean (16384)** for a mode optimized for improved cleaning. They are
not successive points on a single suction scale: Deep Clean is not defined as
stronger than Max. See the [Matter mode definitions](https://csa-iot.org/wp-content/uploads/2024/05/matter-application-cluster-specification.pdf),
sections 1.10.8 and 7.3.7.2.

Native Home choices for Min, Max, Quiet and Deep Clean were observed on iOS 27
with a separately configured S5 Max bridge. This is a controller-compatibility
observation, not verification that untagged aliases remain individually
selectable. Check the presentation and routing of your device's own mapping.

Explicit `customFanSpeedTags` can use these standard tags when they accurately
describe a device's modes. Choose their meaning per device; this change does
not automatically relabel Turbo as Deep Clean or Gentle as Min for every
vacuum. Home supplies the localized display names; personal suction/water
pairings require their own profile implementation.

### Manual Override (suctionLevelEntity)

If your vacuum uses a separate `select.*` entity for suction control instead of the built-in fan speed, configure `suctionLevelEntity` in the Entity Mapping.

---

## Mop Intensity (Apple Home Intensity Options)

When your vacuum supports mop-only cleaning, HAMH adds water-intensity modes under the Mop cleaning type. A combined-only device instead gets `Vacuum & Mop Low`, `Vacuum & Mop Medium` and `Vacuum & Mop High`, tagged for both vacuuming and mopping.

### Auto-Detection

Mop intensity entities are **automatically detected** for Dreame and Ecovacs vacuums. For Roborock, entities matching `*mop_intensity*`, `*mop_pad_humidity*`, `*water_volume*`, or `*water_amount*` are auto-detected.

### Manual Configuration (mopIntensityEntity)

1. Go to **Entity Mappings** → Edit your vacuum
2. Set **Mop Intensity Entity** to the select entity (e.g., `select.roborock_s7_maxv_mop_intensity`)
3. Changes take effect automatically

### Apple Home Intensity Labels

With HAMH's default mop tags, Apple Home uses the same **Quiet / Automatic / Max** labels as for fan speed. These native labels come from the semantic tags and are not a limit on the number of modes the controller can render. Behind the scenes, the routing is:

| Apple Home Label | Mop Intensity Action |
|-----------------|---------------------|
| Quiet | Sets mop to lowest intensity (e.g., "mild", "low") |
| Automatic | Sets mop to medium intensity (e.g., "moderate", "medium") |
| Max | Sets mop to highest intensity (e.g., "intense", "high") |

:::warning
**Mop intensity requires a cleaning mode entity.** Without a cleaning mode entity configured, HAMH cannot determine when the vacuum is in Mop mode, and mop intensity options will not appear in Apple Home. See [Creating a Cleaning Mode Helper](#creating-a-cleaning-mode-helper-roborock--others) above if your integration doesn't provide one natively.
:::

### Matter Spec Limitation: Vacuum & Mop Mode

The Matter spec only allows a single `currentMode` value. When in "Vacuum & Mop" mode, HAMH cannot express both fan speed AND mop intensity simultaneously. For combined-only devices, HAMH reports the water-intensity variant (modes 50-52) while running in combined mode. Devices that also support mop-only keep the base combined mode without an intensity tag. If the cleaning select was unavailable at registration, commands still resolve against its actual live options: a requested Mop option falls back to the combined option when mop-only is unsupported.

---

## Room Selection

Room selection is supported through multiple mechanisms, with automatic priority:

### 1. Home Assistant Area Mapping (HA 2026.3+), Recommended

Starting with Home Assistant 2026.3, vacuums that support the **Clean Area** feature can map their internal segments to your existing HA areas. When this mapping is configured in HA, HAMH automatically uses `vacuum.clean_area` for room cleaning, no vendor-specific configuration needed.

**How it works:**
1. Your vacuum integration reports support for `CLEAN_AREA` (supported_features flag `16384`)
2. You map vacuum segments to HA areas in **Settings → Devices → [Your Vacuum] → Configure**
3. HAMH automatically detects the mapping and creates Matter Service Areas from your HA areas
4. Room cleaning uses the standard `vacuum.clean_area` action instead of vendor-specific commands

This is the **preferred method** when available, as it works with any vacuum integration that supports `CLEAN_AREA` (currently Ecovacs, Roborock, and Matter-based vacuums in HA 2026.3+).

:::note
When `CLEAN_AREA` mapping is detected, it takes priority over all vendor-specific room detection methods (Valetudo segments, Roborock `get_maps`, Dreame rooms, etc.). The vendor-specific methods remain as fallback for vacuums without `CLEAN_AREA` support.
:::

### 2. Service Area Cluster (Apple Home)

Apple Home uses the Matter 1.4 **Service Area** cluster for room selection. This is automatically enabled when your vacuum exposes room data (via Clean Area mapping, vendor attributes, or manual configuration). Requires **Server Mode**.

### 3. RVC Run Mode (Google Home, Alexa, etc.)

Each room is also added as a run mode named after the room, e.g. "Kitchen", "Living Room". Picking one starts a clean of that room only.

Google Home lists run and clean modes by their number (0, 1, 101, ...), not by name, even for the fixed Idle and Cleaning modes ([#516](https://github.com/RiDDiX/home-assistant-matter-hub/issues/516)). HAMH sends the names, the Google Home app does not show them. Picking a number still runs that mode: 101 and up are the rooms in alphabetical order.

For rooms with names in Google Home, turn on **Expose one momentary switch per area** in the vacuum's entity mapping (bridge mode only). Every room then shows up as its own switch named after the room, and turning it on cleans that room. Rename a switch in Google Home if its name clashes with a Google room name in voice commands.

Alexa has no room picker for Matter vacuums. Amazon lists only RVC Run Mode for robot vacuums ([Alexa Supported Matter Device Categories](https://developer.amazon.com/en-US/docs/alexa/smarthome/supported-matter-device-categories.html)), not Service Area, so rooms show up in Alexa only as run modes.

Apple Home can trip over these modes. Pick all rooms and press start, and it may send one room mode, so only that room gets cleaned ([#367](https://github.com/RiDDiX/home-assistant-matter-hub/issues/367), [#511](https://github.com/RiDDiX/home-assistant-matter-hub/issues/511)). If you use the vacuum only from Apple Home, turn on **Don't expose rooms as per-room cleaning modes** in the entity mapping. Rooms then come only from the Service Area picker. Leave it off when Alexa or Google Home start rooms through the modes.

### Room Data Requirements (Vendor-Specific Fallback)

When `CLEAN_AREA` is not available, room selection falls back to vendor-specific room data from entity attributes. Supported formats:

```yaml
# Format 1: Direct object (Roborock)
rooms:
  "16": "Kitchen"
  "17": "Living Room"

# Format 2: Segments array
segments:
  - id: 1
    name: Kitchen
  - id: 2
    name: Living Room

# Format 3: Dreame nested format
rooms:
  "My Home":
    - id: 1
      name: Kitchen
    - id: 2
      name: Living Room
```

---

## Supported Integrations

| Integration | Rooms | Cleaning Modes | Mop Intensity | Notes |
|-------------|-------|----------------|---------------|-------|
| **Roborock (Official)** | Auto via CLEAN_AREA (HA 2026.3+) or `roborock.get_maps` | Via helper (see above) | `select.*_mop_intensity` | CLEAN_AREA preferred when configured |
| **Roborock (Xiaomi Miot)** | `rooms` or `segments` attribute | - | - | Native room support |
| **Dreame** | `rooms` attribute | Auto-detected | Auto-detected | Full auto-detection |
| **Ecovacs** | Auto via CLEAN_AREA (HA 2026.3+) or `rooms` attribute | Via `cleaningModeEntity` | Auto-detected | CLEAN_AREA preferred when configured |
| **Valetudo** | `segments` attribute | Auto-detected | - | Native support since v2.0.27 via `mqtt.publish` segment_cleanup ([#205](https://github.com/RiDDiX/home-assistant-matter-hub/issues/205)) |
| **Xiaomi** | `rooms` attribute | - | - | May require custom integration |
| **iRobot Roomba** | - | - | - | Basic start/stop, use `batteryEntity` mapping |

### Roborock (Official Integration)

Since v2.0.25, HAMH **automatically detects Roborock rooms** via the `roborock.get_maps` service call. No manual button entity mapping is needed.

The startup log will show: `Auto-detected X Roborock rooms`

**Cleaning mode:** Since Home Assistant 2026.8 the Roborock integration exposes a `Cleaning mode` select (options like `vacuum`, `mop`, `vac_and_mop`). HAMH detects it when its entity ID contains `cleaning_mode`, otherwise set it as the Cleaning Mode Entity. On older Home Assistant versions, create a helper entity as described in [Creating a Cleaning Mode Helper](#creating-a-cleaning-mode-helper-roborock--others).

:::note
HAMH now reads `vac_and_mop` as Vacuum & Mop. Before, it was read as mop only. On a Roborock that also offers `mop`, Apple Home's Mop mode and the water intensity modes now start mop only (no suction) instead of vacuum and mop, a separate Vacuum & Mop mode appears, and the current mode shows Vacuum & Mop while the robot runs `vac_and_mop`.
:::

#### Fallback: Manual Button Entity Mapping

If auto-detection doesn't work (e.g., older Roborock firmware), you can use button entities:

1. Open **Entity Mappings** → Edit your vacuum
2. In **Room Button Entities**, select the button entities for each room
3. The UI auto-discovers button entities from the same device

:::tip
You can also create **multi-room scenes** in the Roborock app and map those button entities for combined room cleaning.
:::

---

## Entity Mapping Reference

| Option | Description | When to Use |
|--------|-------------|-------------|
| `cleaningModeEntity` | Select entity for vacuum/mop/vacuum+mop switching | Always, if you want cleaning mode control |
| `suctionLevelEntity` | Select entity for suction / fan speed | Only if vacuum doesn't expose `fan_speed_list` |
| `mopIntensityEntity` | Select entity for mop intensity / water level | When mop control is desired |
| `batteryEntity` | Sensor entity for battery level | Auto-detected; override if auto-detection fails |
| `roomEntities` | Array of button entity IDs for room cleaning | Only if `roborock.get_maps` and room attributes fail |
| `customServiceAreas` | Custom room/zone definitions for generic robots | When your vacuum has no native room support ([#177](https://github.com/RiDDiX/home-assistant-matter-hub/issues/177)) |

---

## Valetudo Support

Since v2.0.27, HAMH has **native Valetudo support**. Valetudo-based vacuums (Dreame, Roborock via Valetudo) are auto-detected and room cleaning uses `mqtt.publish` with `segment_cleanup` instead of `vacuum.send_command`.

### How It Works

1. HAMH detects Valetudo select entities (e.g., `select.*_fan_speed`, `select.*_water_grade`) automatically
2. Room segments are read from the vacuum entity's `segments` attribute
3. Room cleaning commands are sent via `mqtt.publish` to avoid HA entity targeting issues
4. No manual configuration needed, just add your Valetudo vacuum to a Server Mode bridge

### Requirements

- Valetudo firmware with MQTT autodiscovery enabled
- Home Assistant MQTT integration configured
- Vacuum entity exposes `segments` attribute with room data

---

## Custom Service Areas

Since v2.0.27, you can define **custom room/zone names** for generic zone-based robots that don't expose native room data. This is useful for vacuums controlled via IR remotes, generic Tuya integrations, or any robot where HAMH can't auto-detect rooms.

Configure `customServiceAreas` in the Entity Mapping for your vacuum. Each entry defines a room name and the service call to trigger cleaning for that zone.

See [#177](https://github.com/RiDDiX/home-assistant-matter-hub/issues/177) for details.

### Batch Dispatch Mode

By default, HAMH fires **one service call per selected room** in sequence (the correct behavior for Roborock button entities, as introduced in v2.0.44). Some integrations, notably **Xiaomi Home**, instead expect all room IDs in a **single call**. Sending N sequential calls to these integrations causes N separate cleaning trips and effectively cleans only the last room.

Set `batchDispatch: true` on any area definition to opt in. HAMH will fire **one combined call** using that area's `service` and `target` as the template. Matching data keys are combined where possible: arrays are concatenated and primitive values are joined with commas.

HAMH also injects selection metadata into `data`:

| Key | Type | Description |
|-----|------|-------------|
| `selected_area_ids` | `number[]` | Matter area IDs selected by the controller |
| `selected_area_ids_csv` | `string` | The selected Matter area IDs joined by `","` |
| `selected_area_names` | `string[]` | Display names of every selected area |
| `selected_area_names_csv` | `string` | The selected display names joined by `","` |
| `selected_area_data` | `Record<string, unknown>[]` | The original `data` object of each selected area (empty object `{}` for areas with no data) |

Sequential dispatch remains the default, no existing configuration is affected. For predictable batch output, set `batchDispatch: true` on every area that belongs to the same batch-capable integration.

#### Example: Xiaomi Home multi-room cleaning

```yaml
customServiceAreas:
  - name: Kitchen
    service: xiaomi_home.vacuum_clean_room_ids
    target: vacuum.xiaomi_robot
    batchDispatch: true
    data:
      room_ids: [1]
  - name: Living Room
    service: xiaomi_home.vacuum_clean_room_ids
    target: vacuum.xiaomi_robot
    batchDispatch: true
    data:
      room_ids: [2]
  - name: Bedroom
    service: xiaomi_home.vacuum_clean_room_ids
    target: vacuum.xiaomi_robot
    batchDispatch: true
    data:
      room_ids: [3]
```

When "Kitchen" and "Living Room" are selected, HAMH fires a single call with:

```yaml
action: xiaomi_home.vacuum_clean_room_ids
target: vacuum.xiaomi_robot
data:
  room_ids: [1, 2]
  selected_area_ids: [1, 2]
  selected_area_ids_csv: "1,2"
  selected_area_names: [Kitchen, Living Room]
  selected_area_names_csv: "Kitchen,Living Room"
  selected_area_data: [{ room_ids: [1] }, { room_ids: [2] }]
```

For integrations that expect a comma-separated field instead of an array, configure each area with that field as a primitive value. HAMH joins the selected values with commas in batch mode.

See [#291](https://github.com/RiDDiX/home-assistant-matter-hub/issues/291) for the original request.

### Maps and Floors

Each custom area can take two optional settings: `mapName` and `floorNumber`. In the Entity Mapping dialog they are "Map (optional)" and "Floor" on each area.

Areas with the same `mapName` form one Matter map. Maps are listed in the order they first appear. A map name can be up to 64 characters. Set `mapName` on every area or on none. Matter does not allow a mix. If only some areas have one, HAMH leaves the maps out and logs a warning.

`floorNumber` is a whole number. 0 is the main floor. Negative is below ground. Anything else is ignored.

The same room name can be used on two maps. Its fallback run mode is labelled with the map, for example "Bath (Upstairs)". A selection can hold areas from several maps. HAMH calls each area's service in order, same as without maps.

One [report](https://github.com/orgs/home-assistant/discussions/738) says Apple Home on iOS 26 lists Matter maps as floors. Nothing shows a controller using the floor number. Home Assistant's Matter integration reads only the area names.

```yaml
customServiceAreas:
  - name: Kitchen
    service: script.clean_kitchen
    mapName: Ground floor
    floorNumber: 0
  - name: Bath
    service: script.clean_bath_down
    mapName: Ground floor
    floorNumber: 0
  - name: Bath
    service: script.clean_bath_up
    mapName: Upstairs
    floorNumber: 1
```

---

## Identify / Locate

Since v2.0.27, the **Identify** cluster is mapped to `vacuum.locate`. When you use "Play Sound" or "Find My" in Apple Home, the vacuum will play its locate sound.

This works for all vacuum configurations.

---

## Charging State

Since v2.0.27, HAMH reports the `IsCharging` state when the vacuum is docked and charging. Apple Home shows the correct charging indicator. When the battery reaches 100% while docked, `IsAtFullCharge` is also reported.

---

## Roborock recharging within a cleaning job

The Roborock integration exposes an `in_cleaning` binary sensor (display name Cleaning) that remains on
through a mid-job recharge. HAMH resolves this dependency by registry metadata
on the same device, including when the sensor was renamed or is outside the
Matter export filter. Enable the sensor in Home Assistant; missing or ambiguous
matches keep the existing behavior. The automatically resolved dependency is
not written to the saved entity mapping or exported as another accessory.
HAMH looks the sensor up when it creates the vacuum device, so after enabling
or renaming the sensor restart the add-on or container. Restarting a single
bridge keeps the existing vacuum device and does not pick up the change.

With this job signal, the run mode stays Cleaning while returning and charging.
The operational state reports SeekingCharger during the return, then Paused at
the dock with a Recharging phase. Resuming continues the same job. The bridge
sends one OperationCompletion when the job signal turns off at the actual end,
even if the vacuum is already returning, and does not repeat it on arrival.
Offline or temporarily unknown job states do not invent an end; an already
recharging job can be recovered after a bridge restart.

For these job-aware vacuums, 100% at the dock reports AtFullCharge and Docked
even if Roborock's binary charging sensor stays on. An ongoing job still has
priority and remains Paused. Devices without a job signal retain their charging
and completion fallbacks. Normal low-battery returns are never converted into
operational errors. Controllers decide notification text and delivery.

## Troubleshooting

### Vacuum not showing in Apple Home

1. **Use Server Mode**, bridged vacuums don't work in Apple Home. Create a dedicated Server Mode bridge.
2. **Update all Home Hubs**, All HomePods and Apple TVs must be on iOS/tvOS/AudioOS 18.4+
3. **Re-pair**, Remove from Apple Home and add again after enabling Server Mode

### Rooms not appearing in Apple Home

1. **Check Server Mode**, Room selection requires Server Mode
2. **Re-pair the vacuum**, Remove from Apple Home and add again after updating HAMH
3. **Check logs**, Look for `Auto-detected X Roborock rooms` or `Resolved X rooms` in the startup log
4. **Verify room data**, Check your vacuum entity attributes for `rooms`, `segments`, or `room_list`

### Room selection not working

1. Check the logs for errors when selecting a room
2. Verify the vacuum integration supports `vacuum.send_command` with `app_segment_clean`
3. For Roborock: rooms are triggered via the Roborock cloud, ensure cloud connectivity

### Mop intensity not showing in Apple Home

1. **Configure a cleaning mode entity**, Mop intensity requires one. See [Creating a Cleaning Mode Helper](#creating-a-cleaning-mode-helper-roborock--others)
2. **Configure mop intensity entity**, Set `mopIntensityEntity` in Entity Mapping
3. **Re-pair**, New clusters require a fresh pairing

### Apple Home shows "Updating..." or "No Response"

1. **Check Server Mode**, Must be enabled for Apple Home
2. **Check network**, See [Connectivity Issues](../guides/connectivity-issues.md)
3. **Check logs**, Look for errors related to battery, cluster creation, or Matter.js
4. **Factory reset**, As a last resort, factory reset the bridge and re-pair

### iPhone shows "Updating" but iPad works fine

This one comes from [#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287). On some iPhones (reported from iOS 26.4 up to the iOS 27 beta), the vacuum tile gets stuck on "Updating" after a few days of normal use, sometimes right after a network drop. The same vacuum on the same hub still works on iPad and via Siri, so the bridge itself is doing its job. The iPhone's HomeKit daemon stops renewing the Matter subscription after a while and never recovers on its own.

Rebooting the iPhone clears it for a few minutes. Pressing "Locate" in the Home app also unsticks the tile briefly, but it slips back as soon as you close the Home app again.

This one sits on Apple's side, the matter.js maintainer confirmed the same behaviour independently. HAMH keeps the subscription's report interval at 60 seconds, so a fresh report goes out about once a minute even when nothing changed. The bridge is sending data correctly, the iPhone just stops listening once the subscription has expired.

#### Wedge Watchdog

The most targeted fix is **Bridge Settings → Wedge Watchdog** (Stable since v2.0.51, off by default). It watches every session and rotates only the one that keeps acknowledging reports but has not sent a single request for about 45 minutes, which is exactly what a stuck iPhone looks like. The phone re-establishes the session and the tile comes back without a reboot. Turn it on, then look for `Wedge watchdog: rotating session` lines in the log the next time the tile sticks. If the tile still sticks with the watchdog on, post that log window in [#287](https://github.com/RiDDiX/home-assistant-matter-hub/issues/287). Leave it off for bridges that only Google Home uses, Google hubs never send requests between subscriptions and the watchdog would reconnect them every 50 minutes for nothing ([#526](https://github.com/RiDDiX/home-assistant-matter-hub/issues/526)).

#### Built-in session rotation

The bridge can also rotate Matter sessions by age. It is off unless you set a max age (Server Mode used to rotate every 4 hours by default, it no longer does). With a max age set, every 5 minutes the bridge looks for sessions older than that which still hold subscriptions, closes their subscriptions and then the session. The iPhone reacts by re-establishing CASE and re-subscribing, which clears the "Updating" tile without you doing anything.

Set the threshold per bridge under **Bridge Settings → Session Rotation Max Age (hours)**, for example 4. Use a smaller value if your tile gets stuck faster than that. Leave it empty or set `0` to keep rotation off and rely on the Wedge Watchdog or the manual workaround below. The change applies live, no add-on or Docker restart needed. Look for `Rotating session` lines in the logs to confirm the timer fired.

A system-wide fallback is also available for advanced setups via the `HAMH_MATTER_SESSION_MAX_AGE_HOURS` environment variable (Docker `-e` flag or `.env` file). The bridge setting always wins when both are set.

#### Workaround

Run an HA automation that calls `vacuum.locate` on a schedule. The Identify command goes through a different path in iOS than the live state subscription and tends to wake the tile back up:

```yaml
alias: Keep iPhone HomeKit vacuum tile alive
trigger:
  - platform: time_pattern
    hours: "/4"
action:
  - service: vacuum.locate
    target:
      entity_id: vacuum.r2d2
```

The vacuum will beep briefly each time. If you can grab a `sysdiagnose` from a Mac while the tile is stuck, please file it with Apple Feedback. That is the only path to a proper fix on the iOS side.

### "Deep Clean" mode doesn't work

Since v2.0.26, "Vacuum Then Mop" (shown as "Deep Clean" in Apple Home) falls back to "Vacuum & Mop" when your cleaning mode entity doesn't have a dedicated option. If it still fails, check that your cleaning mode entity includes `vacuum_and_mop` as an option.

### Intensity options look the same for Vacuum and Mop mode

This is an Apple Home limitation. Apple renders the same labels (Quiet / Automatic / Max) for both vacuum fan speed and mop intensity because both use the same Matter mode tags. The routing behind the labels is correct, selecting "Quiet" in Mop mode sets mop intensity, while "Quiet" in Vacuum mode sets fan speed.
## Native Roborock operational errors

The bridge reads the Roborock integration's `vacuum_error` enum sensor on the
same Home Assistant device, including when that sensor is outside the Matter
export filter. Detection uses registry metadata, so renamed sensors work. An
explicit `faultEntity` mapping takes precedence; ambiguous automatic matches
are left unmapped. The sensor must be enabled in Home Assistant. An explicit sensor can be selected in the vacuum mapping dialog under **Operational Error Sensor**, or sent as `faultEntity` through the mapping API.

For an actual HA vacuum `error` state, known causes map to standard Matter
RVC error codes, including LowBattery, WheelsJammed, BrushJammed,
NavigationSensorObscured, FailedToFindChargingDock, Stuck and DustBinMissing. The detailed cause is included in `errorStateDetails`.
`errorStateLabel` is reserved for manufacturer-specific codes and is omitted.
Unknown causes use UnableToCompleteOperation, including a Roborock error sensor
that reads none, unavailable or an unlisted value. Vacuums without an error
sensor keep the Stuck fallback.

These errors use the vacuum's native Matter operational-error event. The
controller determines notification availability and wording. A normal return
to charge, an offline device, maintenance counters, or a missing optional mop
attachment do not create a fabricated operational error. Recovering from an
error clears the error attribute.


Operational faults wait up to 500 ms on the initial error transition so a
slightly later Roborock error-sensor update is included in the first error and
completion report. If details remain missing, the bridge reports a generic
fault after this bounded settling period. Later cause changes update the fault
without repeating completion. Recovery cancels a pending error report. An
error already present when the bridge starts is reported at once.
An unavailable vacuum reports Stopped with NoError, rather than the inconsistent
Error/NoError pair; it does not emit an operation-completion event. A vacuum
that returns from unavailable still in error sends the operational-error event
again.
The mapping also includes the library's dock, tank, wash-roller and tray errors
34-56. Only an explicit clean-water-empty code is classified as WaterTankEmpty;
ambiguous dock causes retain a generic native code with the precise details.
