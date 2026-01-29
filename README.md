<div align="center">

# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](./docs/assets/hamh-logo-small.png)

**Expose your Home Assistant devices to Matter controllers like Apple Home, Google Home, and Alexa**

[![GitHub Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?label=stable&color=green)](https://github.com/RiDDiX/home-assistant-matter-hub/releases)
[![GitHub Pre-Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?include_prereleases&label=alpha&color=orange)](https://github.com/RiDDiX/home-assistant-matter-hub/releases)
[![GitHub Issues](https://img.shields.io/github/issues/RiDDiX/home-assistant-matter-hub)](https://github.com/RiDDiX/home-assistant-matter-hub/issues)
[![GitHub Stars](https://img.shields.io/github/stars/RiDDiX/home-assistant-matter-hub)](https://github.com/RiDDiX/home-assistant-matter-hub/stargazers)
[![License](https://img.shields.io/github/license/RiDDiX/home-assistant-matter-hub)](LICENSE)

[📖 Documentation](https://riddix.github.io/home-assistant-matter-hub) • [🐛 Report Bug](https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=bug) • [💡 Request Feature](https://github.com/RiDDiX/home-assistant-matter-hub/issues/new?labels=enhancement)

</div>

---

> [!NOTE]
> 🔀 **Community Fork** - This is a fork of the original [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), which was discontinued in January 2026. We continue active development with bug fixes, new features, and community support. Thank you **t0bst4r** for the original work! ❤️
>
> **📦 Migrating?** See [Migration Guide](#migration-from-t0bst4r) - your paired devices will continue to work!

---

## 📝 About

This project simulates bridges to publish your entities from Home Assistant to any Matter-compatible controller like
Alexa, Apple Home or Google Home. Using Matter, those can be connected easily using local communication without the need
of port forwarding etc.

---

## 📦 Releases & Branches

| Channel | Branch | Current Version | Description |
|---------|--------|-----------------|-------------|
| **Stable** | `main` | v1.7.x | Production-ready, recommended for most users |
| **Alpha** | `alpha` | v2.0.0-alpha.x | Pre-release with new features, for early adopters |
| **Testing** | `testing` | v4.0.0-testing.x | ⚠️ **Highly unstable!** Breaking changes, experimental features |

### Semantic Versioning

We use [Semantic Release](https://semantic-release.gitbook.io/) for automatic versioning:

- `fix:` commits → Patch version bump (1.7.**x**)
- `feat:` commits → Minor version bump (1.**x**.0)
- `BREAKING CHANGE:` → Major version bump (**x**.0.0)

### Which version should I use?

- **Most users**: Use **Stable** (`main` branch) - thoroughly tested
- **Early adopters**: Use **Alpha** (`alpha` branch) - new features, occasional bugs
- **Developers/Testers**: Use **Testing** (`testing` branch) - bleeding edge, expect breakage

### Current Stable Features (v1.7.x) 🎉

#### Core Features
- **Matter Bridge** - Expose Home Assistant entities to Matter controllers
- **Multi-Fabric Support** - Connect to multiple ecosystems (Apple, Google, Alexa)
- **Node.js 24** - Latest LTS runtime
- **64-bit Only** - Supports `amd64` and `arm64` (aarch64)

#### Stability & Error Handling
- **Graceful Crash Handler** - Failed entities no longer crash the bridge
  - Problematic entities are automatically skipped during boot
  - Failed entities are displayed in the UI with detailed error messages
  - Bridge continues to run with remaining healthy entities
- **Automatic Recovery** - Auto-restart failed bridges with configurable intervals
- **Access Control Fix** - Fixed attribute write issues using `asLocalActor`
- **Thermostat Setpoint Limits** - Expanded limits to allow full temperature range
- **HVAC Mode Detection** - Correctly sends single temperature in heat/cool mode
- **Google Home Compatibility** - Fixed brightness control with null transitionTime

#### APIs & Backend
- **Health Check API** (`/api/health`, `/api/health/detailed`) - System status and Kubernetes-ready probes
- **System Info API** (`/api/system/info`) - CPU, memory, storage, network info
- **Logs API** (`/api/logs`) - Retrieve, filter, search, and clear application logs
- **Metrics API** (`/api/metrics`) - Prometheus-compatible metrics endpoint
- **WebSocket Live Updates** (`/api/ws`) - Real-time bridge status updates

#### UI Features
- **Health Monitoring Dashboard** - Real-time bridge and fabric status
- **System Information Panel** - CPU, memory, storage stats
- **Log Viewer Dialog** - View, filter, and search logs from UI
- **Bridge Wizard** - Guided setup for multiple bridges
- **Dark Mode Toggle** - Switch between light and dark theme
- **Device List Sorting** - Sort endpoints by name, type, or ID
- **Alphabetical Bridge Sorting** - Bridges sorted by name
- **Alphabetical Device Types** - Matter device types sorted alphabetically in dropdowns
- **Filter Preview** - Preview which entities match your filter
- **All Devices Button** - Quick access to all devices from bridge details
- **Card View Improvements** - Shows all leaf devices, not just aggregators

#### Backup & Restore
- **Full Backup/Restore** - Download complete backups as ZIP
- **Full Backup with Identity** - Preserve Matter commissioning across reinstalls
  - Includes Matter keypairs and fabric credentials
  - No re-commissioning needed after restore

#### Entity Mapping
- **Entity Mapping Customization** - Override Matter device types per entity
- **Custom Names** - Custom names for entities in Matter
- **Disable Entities** - Disable specific entities from bridge

#### Device Types
- **Water Valve** - Control water valves via Matter
- **Smoke/CO Detector** - Binary sensors (separate device types)
- **Pressure Sensor** - Atmospheric pressure measurements
- **Flow Sensor** - Volume flow rate measurements
- **PM2.5/PM10 Sensors** - Real concentration values in µg/m³
- **Air Purifier** - Map fans via entity mapping
- **Pump Device** - Map switches/valves via entity mapping
- **AirQuality Sensors** - AQI, PM2.5, PM10, CO2, VOC
- **Media Player** - Volume and playback controls
- **Improved Fan Control** - Better speed control compatibility

### Alpha (v2.0.0-alpha) 🧪

> [!WARNING]
> Alpha versions are for early adopters testing new features before stable release.

**Currently identical to Stable** - All features have been merged to main!

Alpha is used for:
- Testing new features before stable release
- Early access to bug fixes
- Community feedback on upcoming changes

### Testing (v4.0.0-testing) ⚠️

> [!CAUTION]
> Testing versions are **highly unstable** and may contain BREAKING CHANGES!
> Intended for developers and testers only. Features may be incomplete, broken, or removed without notice.

All alpha features plus:
- Experimental Matter.js updates
- Cutting-edge features being actively developed
- Breaking changes may occur between versions

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

## 🙏 Contributors & Acknowledgments

This project thrives thanks to the amazing community! Special thanks to everyone who contributes by reporting bugs, suggesting features, and helping others.

### 🏆 Top Contributors

| Contributor | Contributions |
|-------------|---------------|
| [@codyc1515](https://github.com/codyc1515) | 🥇 **Top Contributor** - Climate/thermostat bugs (#24, #21, #20, #9), alphabetical sorting PR ([#48](https://github.com/RiDDiX/home-assistant-matter-hub/pull/48)), extensive testing |
| [@depahk](https://github.com/depahk) | 📝 Migration documentation fix ([#32](https://github.com/RiDDiX/home-assistant-matter-hub/pull/32)) |
| [@Fettkeewl](https://github.com/Fettkeewl) | 🐛 Script import bug (#26), Alias feature request (#25) |
| [@razzietheman](https://github.com/razzietheman) | 💡 Feature requests: Preserve commissioned state (#31), alphabetical sorting (#30) |

### 📋 Issue Tracker - All Contributors

Thank you to everyone who helps improve this project by reporting issues!

| User | Issues | Type |
|------|--------|------|
| [@Chrulf](https://github.com/Chrulf) | [#41](https://github.com/RiDDiX/home-assistant-matter-hub/issues/41) | 🐛 Google Home brightness |
| [@nexusis7](https://github.com/nexusis7) | [#9](https://github.com/RiDDiX/home-assistant-matter-hub/issues/9) | 🐛 Climate/Thermostat control |
| [@chromaxx7](https://github.com/chromaxx7) | [#29](https://github.com/RiDDiX/home-assistant-matter-hub/issues/29) | 🐛 Climate crash |
| [@Tomyk9991](https://github.com/Tomyk9991) | [#28](https://github.com/RiDDiX/home-assistant-matter-hub/issues/28) | 🐛 Heat/Cool startup |
| [@datvista](https://github.com/datvista) | [#27](https://github.com/RiDDiX/home-assistant-matter-hub/issues/27) | 🐛 Add-on start |
| [@bwynants](https://github.com/bwynants) | [#23](https://github.com/RiDDiX/home-assistant-matter-hub/issues/23) | 🐛 OccupancySensor |
| [@Pozzi831](https://github.com/Pozzi831) | [#22](https://github.com/RiDDiX/home-assistant-matter-hub/issues/22) | 🐛 AC problems |

### 💖 Sponsors

A huge thank you to our sponsors who help keep this project alive!

| Sponsor | |
|---------|---|
| [@thorsten-gehrig](https://github.com/thorsten-gehrig) | 🥇 **First Sponsor!** Thank you for believing in this project! |
| [@SH1FT-W](https://github.com/SH1FT-W) | 💎 Thank you for your generous support! |

### 🌟 Original Author

- **[@t0bst4r](https://github.com/t0bst4r)** - Creator of the original Home-Assistant-Matter-Hub project

---

## ☕ Support the Project

> [!NOTE]
> **Completely optional!** This project will continue regardless of donations.
> I maintain this in my free time because I believe in open source.

If you find this project useful, consider supporting its development:

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal&style=for-the-badge)](https://www.paypal.me/RiDDiX93)

Your support helps cover hosting costs and motivates continued development. Thank you! ❤️

---

## 📊 Project Stats

<div align="center">

![GitHub commit activity](https://img.shields.io/github/commit-activity/m/RiDDiX/home-assistant-matter-hub)
![GitHub last commit](https://img.shields.io/github/last-commit/RiDDiX/home-assistant-matter-hub)
![GitHub issues](https://img.shields.io/github/issues/RiDDiX/home-assistant-matter-hub)
![GitHub closed issues](https://img.shields.io/github/issues-closed/RiDDiX/home-assistant-matter-hub)
![GitHub pull requests](https://img.shields.io/github/issues-pr/RiDDiX/home-assistant-matter-hub)

</div>

---
