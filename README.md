# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](./docs/assets/hamh-logo-small.png)

---

> [!NOTE]
> 🔀 **This is a Community Fork**
>
> This repository is a fork of the original [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), 
> which was discontinued by its original maintainer in January 2026.
>
> I have decided to continue development of this project to keep it alive and maintained for the community.
>
> **Current Status:**
> - ✅ Active development and maintenance
> - ✅ Bug fixes and updates
> - ✅ Community support
>
> Thank you to **t0bst4r** for the original work on this amazing project! ❤️
>
> **📦 Migrating from t0bst4r's version?** See [Migration](#migration-from-t0bst4r) below - your existing configuration and paired devices will continue to work!

---

## About

This project simulates bridges to publish your entities from Home Assistant to any Matter-compatible controller like
Alexa, Apple Home or Google Home. Using Matter, those can be connected easily using local communication without the need
of port forwarding etc.

---

## Releases & Branches

| Channel | Branch | Current Version | Description |
|---------|--------|-----------------|-------------|
| **Stable** | `main` | v1.7.x | Production-ready, recommended for most users |
| **Alpha** | `alpha` | v2.0.0-alpha.x | Pre-release with new features, for early adopters |
| **Testing** | `testing` | v2.0.0-testing.x | ⚠️ **Highly unstable!** Experimental features, may break |

### Semantic Versioning

We use [Semantic Release](https://semantic-release.gitbook.io/) for automatic versioning:

- `fix:` commits → Patch version bump (1.7.**x**)
- `feat:` commits → Minor version bump (1.**x**.0)
- `BREAKING CHANGE:` → Major version bump (**x**.0.0)

### Which version should I use?

- **Most users**: Use **Stable** (`main` branch) - thoroughly tested
- **Early adopters**: Use **Alpha** (`alpha` branch) - new features, occasional bugs
- **Developers/Testers**: Use **Testing** (`testing` branch) - bleeding edge, expect breakage

### Stable Features (v1.5.x)

- **Matter Bridge** - Expose Home Assistant entities to Matter controllers
- **Multi-Fabric Support** - Connect to multiple ecosystems (Apple, Google, Alexa)
- **Graceful Error Handling** - Skips problematic entities without crashing
- **Failed Entity Reporting** - Shows which entities couldn't be loaded and why
- **Health Monitoring Dashboard** - Real-time bridge and fabric status monitoring
- **Automatic Recovery** - Auto-restart failed bridges with configurable intervals
- **Bridge Wizard** - Guided setup for creating multiple bridges with automatic port assignment
- **AirQuality Sensors** - Support for AQI, PM2.5, PM10, CO2, and VOC sensors
- **Improved Fan Control** - Better speed control compatibility with Matter controllers
- **Media Player Playback** - Play/Pause/Stop/Next/Previous track controls
- **Node.js 24** - Latest LTS runtime
- **64-bit Only** - Supports `amd64` and `arm64` (aarch64)

### Stable Features (v1.7.x)

- **Dark Mode Toggle** - Switch between light and dark theme
- **Device List Sorting** - Sort endpoints by name, type, or ID

### Stable Features (v1.8.x) - NEW! 🎉

- **Graceful Crash Handler** - Failed entities no longer crash the bridge
  - Problematic entities are automatically skipped during boot
  - Failed entities are displayed in the UI with detailed error messages
  - Bridge continues to run with remaining healthy entities
- **PM2.5/PM10 Numeric Sensors** - Real concentration values in µg/m³ (not just quality levels)
- **Access Control Fix** - Fixed attribute write issues using `asLocalActor` ([Matter.js #3105](https://github.com/matter-js/matter.js/issues/3105))
- **Water Valve Support** - Control water valves via Matter
- **Smoke/CO Detector** - Binary sensors for smoke and carbon monoxide alarms (separate device types)
- **Pressure Sensor** - Atmospheric pressure measurements
- **Flow Sensor** - Volume flow rate measurements
- **Air Purifier** - Map fans to Air Purifier device type via entity mapping
- **Pump Device** - Map switches/valves to Pump device type via entity mapping

### Alpha Features (v2.0.0-alpha) 🧪

> [!WARNING]
> Alpha versions are for early adopters and may contain bugs!

All stable features plus:
- **Health Check API** (`/api/health`)
  - System status, uptime, and service information
  - Kubernetes-ready probes (`/live`, `/ready`)
- **WebSocket Live Updates** (`/api/ws`)
  - Real-time bridge status updates
  - No more polling required
- **Entity Mapping Customization**
  - Override Matter device types per entity
  - Custom names for entities in Matter
  - Disable specific entities from bridge
- **Full Backup/Restore** - Download complete backups as ZIP including entity mappings
- **Filter Preview** - Preview which entities match your filter before saving
- **Dark Mode Toggle** - Switch between light and dark theme
- **Device List Sorting** - Sort endpoints by name, type, or ID
- **Full Backup with Identity** - Preserve Matter commissioning across reinstalls
- **Alphabetical Bridge Sorting** - Bridges sorted by name in UI

### Testing Features (v2.0.0-testing) ⚠️

> [!CAUTION]
> Testing versions are **highly unstable** and intended for developers only!
> Features may be incomplete, broken, or removed without notice.

All alpha features plus experimental changes being actively developed.

---

## Supported Device Types

| Home Assistant Domain | Matter Device Type |
|-----------------------|-------------------|
| `light` | On/Off, Dimmable, Color Temperature, Extended Color Light |
| `switch`, `input_boolean` | On/Off Plug-in Unit |
| `lock` | Door Lock |
| `cover` | Window Covering |
| `climate` | Thermostat |
| `fan` | Fan |
| `binary_sensor` | Contact, Occupancy, Smoke/CO Alarm, Water Leak Sensor |
| `sensor` | Temperature, Humidity, Pressure, Flow, Light, AirQuality Sensor |
| `button`, `input_button` | Generic Switch |
| `media_player` | Speaker with Volume and Playback Controls |
| `valve` | Water Valve |
| `vacuum` | Robot Vacuum Cleaner |
| `humidifier` | Humidifier/Dehumidifier |
| `automation`, `script`, `scene` | On/Off Switch |

---

## Installation

### Home Assistant Add-on (Recommended)

Add this repository to your Add-on Store:

```
https://github.com/RiDDiX/home-assistant-addons
```

Two add-ons are available:
- **Home-Assistant-Matter-Hub** - Stable release
- **Home-Assistant-Matter-Hub (Alpha)** - Pre-release for testing

### Docker

```bash
docker run -d \
  --name home-assistant-matter-hub \
  --network host \
  -v /path/to/data:/data \
  -e HOME_ASSISTANT_URL=http://homeassistant.local:8123 \
  -e HOME_ASSISTANT_ACCESS_TOKEN=your_token \
  ghcr.io/riddix/home-assistant-matter-hub:latest
```

For alpha versions, use tag `alpha` instead of `latest`.

---

## Documentation

Please see the [documentation](https://riddix.github.io/home-assistant-matter-hub) for detailed installation instructions,
configuration options, known issues, limitations and guides.

---

## Migration from t0bst4r

Migrating from the original `t0bst4r/home-assistant-matter-hub` is straightforward. **Your Matter fabric connections and paired devices will be preserved!**

### Home Assistant Add-on

1. **Backup your data:**
   ```bash
   # SSH into Home Assistant and find your add-on folder
   ls /addon_configs/
   # Look for folder ending with _hamh (e.g., a0c_hamh)
   
   cp -r /addon_configs/*_hamh /config/hamh-backup
   ```

2. **Uninstall the old add-on** (Settings → Add-ons → Uninstall)

3. **Add the new repository:**
   ```
   https://github.com/RiDDiX/home-assistant-addons
   ```

4. **Install and start the new add-on**, then check the new _hamh folder:
   ```bash
   ls /addon_configs/
   ```

5. **Stop the add-on** and restore your backup:
   ```bash
   cp -r /config/hamh-backup/* /addon_configs/*_hamh/
   ```

6. **Start the add-on again** - your devices should reconnect automatically

### Docker / Docker Compose

Simply change the image from:
```
ghcr.io/t0bst4r/home-assistant-matter-hub:latest
```
to:
```
ghcr.io/riddix/home-assistant-matter-hub:latest
```

Your volume mounts stay the same - no data migration needed.

> For detailed instructions, see the [full Migration Guide](https://riddix.github.io/home-assistant-matter-hub/migration-from-t0bst4r/).

---

## Support the Project

> [!NOTE]
> **This is completely optional!** The project will continue regardless of donations.
> I maintain this in my free time because I believe in open source and helping the community.

If you find this project useful and want to support its development, consider buying me a coffee! ☕

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://www.paypal.me/RiDDiX93)

Maintaining this project takes time and effort - from fixing bugs, adding new features, to helping users in issues.
Your support is appreciated but never expected. Thank you for using Home-Assistant-Matter-Hub! ❤️

---
