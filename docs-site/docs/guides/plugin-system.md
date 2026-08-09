# Plugin System

Home Assistant Matter Hub supports plugins that register additional Matter devices on the bridge. Plugins can provide virtual devices or integrate third-party services.

## Installing a Plugin

### From npm

1. Open the **Plugins** page in the HAMH web UI
2. Enter the npm package name (e.g., `hamh-plugin-example`)
3. Click **Install**
4. Restart the bridge to load the plugin

### From a local `.tgz` file

Upload a packaged plugin via the API:

```bash
curl -X POST http://localhost:8482/api/plugins/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @hamh-plugin-example-1.0.0.tgz
```

### From a local folder (development)

Link a local plugin directory:

```bash
curl -X POST http://localhost:8482/api/plugins/install-local \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/your/plugin"}'
```

This creates a symlink, so changes to your plugin source apply on bridge restart. Note that locally linked plugins are not added to the internal `package.json` dependencies, they rely on the symlink persisting. This method is intended for development only.

## Writing a Plugin

A plugin is an npm package that exports a class implementing the `MatterHubPlugin` interface.

### Minimal Structure

```
my-plugin/
  package.json
  index.js
```

**package.json:**

```json
{
  "name": "hamh-plugin-my-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module",
  "hamhPluginApiVersion": 1
}
```

The `hamhPluginApiVersion` field declares which plugin API version your plugin targets. HAMH logs a warning if this doesn't match the current API version.

**index.js:**

```javascript
export default class MyPlugin {
  readonly name = "hamh-plugin-my-plugin";
  readonly version = "1.0.0";

  async onStart(context) {
    await context.registerDevice({
      id: "my-device-1",
      name: "My Device",
      deviceType: "temperature_sensor",
      clusters: [
        {
          clusterId: "temperatureMeasurement",
          attributes: { measuredValue: 2150 },
        },
      ],
    });
  }

  async onShutdown() {
    // Clean up timers, connections, etc.
  }
}
```

### Plugin Lifecycle

| Hook | When | Purpose |
|------|------|---------|
| `onStart(context)` | Bridge starts | Register devices, set up connections |
| `onConfigure()` | After all devices registered | Restore persistent state |
| `onShutdown(reason?)` | Bridge stops | Clean up resources |
| `getConfigSchema()` | On demand | Provide config UI schema |
| `onConfigChanged(config)` | User updates config | Apply new configuration |

### PluginContext API

The `context` object passed to `onStart` provides:

- **`registerDevice(device)`**, Register a Matter device on the bridge
- **`unregisterDevice(deviceId)`**, Remove a previously registered device
- **`updateDeviceState(deviceId, clusterId, attributes)`**, Push attribute updates to a device
- **`registerDomainMapping(mapping)`**, Map an HA domain to a Matter device type (see [Domain Mappings](#domain-mappings))
- **`storage`**, Persistent key-value store (survives restarts)
- **`log`**, Scoped logger (`info`, `warn`, `error`, `debug`)
- **`bridgeId`**, ID of the bridge this plugin is attached to

### Supported Device Types

| Key | Matter Device |
|-----|--------------|
| `on_off_light` | On/Off Light (0x0100) |
| `dimmable_light` | Dimmable Light (0x0101) |
| `color_temperature_light` | Color Temperature Light (0x0102) |
| `extended_color_light` | Extended Color Light (0x010D) |
| `on_off_plugin_unit` | On/Off Plug-in Unit (0x010A) |
| `dimmable_plug_in_unit` | Dimmable Plug-in Unit (0x010B) |
| `temperature_sensor` | Temperature Sensor (0x0302) |
| `humidity_sensor` | Humidity Sensor (0x0307) |
| `pressure_sensor` | Pressure Sensor (0x0305) |
| `flow_sensor` | Flow Sensor (0x0306) |
| `light_sensor` | Light Sensor (0x0106) |
| `occupancy_sensor` | Occupancy Sensor (0x0107) |
| `contact_sensor` | Contact Sensor (0x0015) |
| `air_quality_sensor` | Air Quality Sensor (0x002C) |
| `thermostat` | Thermostat (0x0301) |
| `door_lock` | Door Lock (0x000A) |
| `fan` | Fan (0x002B) |
| `window_covering` | Window Covering (0x0202) |
| `generic_switch` | Generic Switch (0x000F) |
| `water_leak_detector` | Water Leak Detector (0x0043) |

### Custom endpoints (advanced)

If the device type or cluster you need is not in the table above, a plugin can supply its own matter.js `EndpointType` via `endpointType` instead of `deviceType`. This lets you expose any Matter device type, including ones with custom clusters and your own command handlers (a `Behavior` subclass), without changes to HAMH core.

```typescript
import { OnOffLightDevice } from "@matter/main/devices";

const MyDeviceType = OnOffLightDevice.with(MyCustomBehavior); // your Behavior with command handlers

await context.registerDevice({
  id: "my-device-1",
  name: "My Device",
  endpointType: MyDeviceType, // provide this OR deviceType, not both
  clusters: [], // optional initial attribute state
});
```

:::warning matter.js instance matters
A live `EndpointType` only works if it comes from the exact same matter.js instance the backend runs. The backend bundles `@matter/*`, while externally installed plugins live in a separate folder and resolve their own copy, so a live `endpointType` from an external package will not attach. Plugins that pass live matter.js objects therefore ship as built-ins (see below). External plugins are best for the `deviceType` + cluster-data flow, which crosses the boundary as plain data.
:::

### Built-in plugins

Some device types need a live matter.js `EndpointType` (custom clusters and command handlers), which only works from inside the backend bundle. These ship as built-in plugins. They show up in the Plugins page like any other plugin and are configured there; nothing to install.

Plugins run on standard bridges only. A bridge with Server Mode enabled hosts no plugins at all, including the built-in camera; the Plugins page lists it with a note saying so. If every bridge you have is in Server Mode, create a standard bridge and put the camera there. Apple Home does not render Matter cameras; as of 2026 SmartThings is the only controller that does.

**Camera** exposes a Home Assistant camera as a Matter Camera (0x0142). It implements the Matter `WebRtcTransportProvider` flow and bridges HA's WebRTC. To configure it, open the Plugins page and click the camera plugin (or its gear icon). A settings dialog opens; fill in the cameras and save:

| Setting | Description |
|---------|-------------|
| `cameras` | Camera entity ids, comma-separated, e.g. `camera.front,camera.garage`. This is the only field you need to set. |
| `haUrl` | Optional. Leave empty to reuse the bridge's Home Assistant connection. Only set it to point at a different HA. |
| `haToken` | Optional. Leave empty to reuse the bridge's connection, or set a long-lived token to match a custom `haUrl`. |

Plugin config is stored per bridge, so set the cameras on each bridge that should expose them. Upgrading from a build before this split resets the config once, so re-enter the cameras after updating.

SmartThings live view needs Matter over TCP: the WebRTC offer the camera sends is far larger than Matter's UDP message size, so the stream stalls over UDP alone. A bridge with cameras configured turns on a Matter TCP listener on the bridge's operational port automatically, both on start and after you save the camera list. Host networking already covers this; a strict firewall must allow TCP on the bridge port. The TCP capability is advertised to every controller on that bridge, so if another controller misbehaves with it, keep the cameras on a dedicated bridge.

Live view answers now travel back to the controller: after the camera computes its SDP answer, the bridge invokes the `answer` command on the controller's `WebRtcTransportRequestor` cluster over the same session, so the handshake completes instead of stalling with the answer discarded. The answer SDP already carries the camera's gathered ICE candidates, so no separate candidate trickle is sent from our side.

Experimental: the media path is delivered but not yet verified end to end on real hardware, and as of 2026 only SmartThings renders Matter cameras.

**Security** is experimental and turns the bridge into a small alarm system for setups that have no alarm integration. It registers four exclusive mode switches (Home, Away, Night, Vacation) and an Alarm contact sensor. Arming is turning a mode switch on, from any controller or by voice: "Alexa, turn on Away". Turning the active switch off disarms, and all switches off means disarmed; the plugin turns the other three off whenever one goes on. The Alarm sensor opens while the alarm is tripped, so controller automations can react to it. There is no PIN: anything that can flip the mode switches can also disarm, so expose them only to controllers you trust.

Arming waits out the exit delay, then the mode's setters are invoked (each entity gets its domain's `turn_on`, so scripts and scenes run and switches turn on). While armed, `door`/`window`/`garage_door`/`opening` binary sensors get the entry delay; every other trigger class trips instantly. A trip turns on the mode's alerts plus the Always list and opens the Alarm sensor. After the trigger time the alarm returns to the state it was tripped from (the armed mode, or disarmed for a 24h trip while disarmed) and siren/switch/light alerts get a `turn_off` (scripts and scenes do not); a trigger time of 0 keeps it tripped until disarm. A 24h trip while disarmed with a trigger time of 0 has no single Matter-side clear: arm any mode and disarm again to reset it. The armed state is persisted, so a restart mid-armed comes back armed. Trigger events during a Home Assistant connection gap are lost; the connection resubscribes on its own once HA is back. A silence or a mode's setters that hit such a gap are not lost: due `turn_off` calls are persisted until Home Assistant confirms them, and held setters are replayed on reconnect if that mode is still armed.

Every entity field is a comma-separated list, deduplicated on parse. Alert lists accept only `siren`, `switch` and `light` (turned off again when the alarm clears) plus `script` and `scene` (fire-only); entities from any other domain are dropped with a warning.

| Setting | Description |
|---------|-------------|
| `exitDelaySeconds` | Delay before an armed mode takes effect. Default 60, 0 disables. |
| `entryDelaySeconds` | Delay for perimeter (door/window/garage door/opening) sensors while armed. Default 60, 0 disables. |
| `triggerTimeSeconds` | How long the alarm stays tripped before returning to the state it was tripped from. Default 120, 0 keeps it tripped until disarm. |
| `homeSetters` / `awaySetters` / `nightSetters` | Entities invoked when that mode is reached, comma-separated. |
| `offSetters` | Entities invoked on disarm. |
| `homeTriggers` / `awayTriggers` / `nightTriggers` | Sensors that trip the alarm in that mode. |
| `homeAlerts` / `awayAlerts` / `nightAlerts` | Entities turned on when the alarm trips in that mode. Siren/switch/light and script/scene only. |
| `vacationSetters` / `vacationTriggers` / `vacationAlerts` | Independent lists; left empty they use the Away lists. |
| `triggers24h` | Trip the alarm in every state including disarmed, never with entry delay. Smoke, gas, water leak. |
| `alerts24h` | Entities turned on when a 24h trigger trips. Same domains as the mode alerts. |
| `alwaysAlerts` | Master alert list, fired on every trip in addition to the tier's alerts. |
| `haUrl` / `haToken` | Optional. Set both to point the plugin at a different Home Assistant; one without the other is ignored with a warning. Left empty the plugin dials its own socket with the bridge's credentials (the bridge connection itself is not reused). |

Known limits: changing `haUrl`/`haToken` while silences or setters are still pending can replay them against the new Home Assistant, and a silence that keeps failing is retried on every reconnect without a cap. Both are on the list for the next revision.

If you already run Alarmo or another alarm integration, keep using it and bridge its `alarm_control_panel` entity instead. This plugin runs its own state machine, so pointing both at the same sensors gives you two independent alarms that do not know about each other. The first version targets users without an alarm integration.

### Cluster IDs

Use Matter.js behavior key names as cluster IDs. Common ones:

| Cluster ID | Description |
|-----------|------------|
| `onOff` | On/Off state |
| `levelControl` | Brightness level |
| `colorControl` | Color (hue/saturation/temperature) |
| `pressureMeasurement` | Pressure (in 0.1 kPa units) |
| `flowMeasurement` | Flow rate (in 0.1 m³/h units) |
| `windowCovering` | Window covering position and motion |
| `temperatureMeasurement` | Temperature (in 0.01°C units) |
| `relativeHumidityMeasurement` | Relative humidity (in 0.01% units) |
| `booleanState` | Binary state (open/closed) |
| `occupancySensing` | Occupancy detection |
| `fanControl` | Fan speed and mode |
| `doorLock` | Lock state |

### Handling Controller Commands

When a Matter controller writes an attribute (e.g., turns a light on), your device's `onAttributeWrite` callback is called:

```typescript
await context.registerDevice({
  id: "my-light",
  name: "My Light",
  deviceType: "on_off_light",
  clusters: [
    { clusterId: "onOff", attributes: { onOff: false } },
  ],
  onAttributeWrite: async (clusterId, attribute, value) => {
    if (clusterId === "onOff" && attribute === "onOff") {
      console.log(`Light turned ${value ? "on" : "off"}`);
      // Forward to your actual hardware/service
    }
  },
});
```

### Persistent Storage

Use `context.storage` to persist data across restarts:

```typescript
// Save
await context.storage.set("lastState", { temperature: 21.5 });

// Restore
const saved = await context.storage.get("lastState");
```

### Plugin Config Schema

Plugins can provide a JSON-schema-like config for the UI:

```typescript
getConfigSchema() {
  return {
    title: "My Plugin Config",
    properties: {
      pollingInterval: { type: "number", title: "Polling Interval (ms)" },
      apiKey: { type: "string", title: "API Key" },
    },
  };
}

async onConfigChanged(config) {
  this.pollingInterval = config.pollingInterval ?? 30000;
}
```

## Domain Mappings

Plugins can register domain mappings to tell HAMH how to handle HA entity domains that are not natively supported. Call `context.registerDomainMapping()` during `onStart`:

```javascript
async onStart(context) {
  // Map all "number" entities to dimmable lights
  context.registerDomainMapping({
    domain: "number",
    matterDeviceType: "dimmable_light",
  });
}
```

The `matterDeviceType` must be one of the [Supported Device Types](#supported-device-types). Plugin domain mappings are checked after user-configured overrides but before the built-in domain table, they only apply to domains that HAMH does not already handle.

If multiple plugins register the same domain, the last one wins (a warning is logged).

## Cloud Provider / Device Source Plugins

Plugins can integrate external cloud services by discovering devices, polling for state, and forwarding controller commands. See `examples/hamh-plugin-cloud-mock/` for a full working example that demonstrates:

- Device discovery from an external API
- Periodic polling for state changes
- Forwarding Matter controller commands to the cloud API
- Storing API tokens securely via `context.storage` (never logged)
- Config schema for polling interval and credentials

Replace the `MockCloudApi` class with your real provider's SDK to build a production plugin.

## Error Handling

Plugins run in-process with a safety wrapper:

- **Timeout**: Each lifecycle call has a 10-second timeout
- **Circuit breaker**: 3 consecutive failures auto-disable the plugin
- **Recovery**: Use the **Reset** button in the Plugins UI to re-enable a disabled plugin
- **Unhandled rejections**: Fire-and-forget promises from plugins are caught at the process level and logged without crashing HAMH

The bridge continues running even if a plugin fails. See `examples/hamh-plugin-broken/` for a test plugin that exercises various failure modes.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Plugin not loading after install | Restart the bridge, plugins load on startup |
| "Circuit breaker tripped" | Check logs for the error, fix the issue, then click Reset |
| Device not appearing in controller | Verify `deviceType` is in the supported list above |
| Attribute updates ignored | Ensure `clusterId` matches a behavior key (e.g., `onOff`, not `OnOff`) |
| Plugin crashes on start | Check that `onStart` doesn't throw, wrap risky code in try/catch |

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins` | GET | List installed packages and active plugins per bridge |
| `/api/plugins/install` | POST | Install from npm (`{ packageName }`) |
| `/api/plugins/upload` | POST | Install from uploaded `.tgz` (binary body) |
| `/api/plugins/install-local` | POST | Link local folder (`{ path }`) |
| `/api/plugins/uninstall` | POST | Uninstall package (`{ packageName }`) |
| `/api/plugins/:bridgeId/:pluginName/enable` | POST | Enable a plugin |
| `/api/plugins/:bridgeId/:pluginName/disable` | POST | Disable a plugin |
| `/api/plugins/:bridgeId/:pluginName/reset` | POST | Reset circuit breaker |
| `/api/plugins/:bridgeId/:pluginName/config-schema` | GET | Get config schema |
| `/api/plugins/:bridgeId/:pluginName/config` | POST | Update config (`{ config }`) |
