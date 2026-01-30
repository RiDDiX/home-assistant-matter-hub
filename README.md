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
| **Stable** | `main` | v1.10.x | Production-ready, recommended for most users |
| **Alpha** | `alpha` | v2.0.0-alpha.x | Pre-release with new features, for early adopters |
| **Testing** | `testing` | v4.0.0-testing.x | ⚠️ **Highly unstable!** Experimental features, may break |

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

### Stable Features (v1.9.0) - NEW! 🎉

All previous features plus:

**🎨 Bridge Icons & UI**
- **Custom Bridge Icons** - Upload your own PNG, JPG, GIF, WebP, or SVG icons (max 5MB)
- **Domain-based Icons** - Automatic icon assignment based on bridge domain (light, climate, etc.)
- **Name-based Icon Fallback** - Icons derived from bridge names ("Lamps" → 💡)
- **20 Preset Icons** - Quick selection dropdown in bridge editor
- **Entity Mapping Button** - Quick access to entity mapping from bridge card view
- **Improved Status Labels** - Cleaner spacing and layout

**📺 Media & Devices**
- **Basic Video Player** - TV and media player support for Apple Home ([#45](https://github.com/RiDDiX/home-assistant-matter-hub/issues/45))
- **Alexa Deduplication** - UniqueId in BridgedDeviceBasicInformation prevents duplicate devices ([#53](https://github.com/RiDDiX/home-assistant-matter-hub/issues/53))

**🌡️ Thermostat Improvements**
- **Auto-only Thermostat Support** - Thermostats with only "auto" mode now work correctly ([#54](https://github.com/RiDDiX/home-assistant-matter-hub/issues/54))
- **Heating+Cooling Constraint Fixes** - Proper handling of Matter.js deadband requirements
- **Google Home Fix** - Handle null transitionTime from Google Home ([#41](https://github.com/RiDDiX/home-assistant-matter-hub/issues/41))
- **Temperature Range Detection** - Check HVAC mode for range support ([#9](https://github.com/RiDDiX/home-assistant-matter-hub/issues/9))

**🔧 Infrastructure**
- **Health Check API** (`api/health`) - System status and Kubernetes-ready probes
- **WebSocket Live Updates** (`api/ws`) - Real-time bridge status, no polling
- **Ingress Compatibility** - Fixed WebSocket and API routing for Home Assistant Ingress
- **Full Backup/Restore** - Complete backups including entity mappings and Matter identity
- **Filter Preview** - Preview entity matches before saving

### Alpha Features (v2.0.0-alpha) 🧪

> [!WARNING]
> Alpha versions are for early adopters and may contain bugs!

All stable features plus experimental changes being actively developed.

### Testing Features (v4.0.0-testing) ⚠️

> [!CAUTION]
> Testing versions are **highly unstable** and intended for developers only!
> Features may be incomplete, broken, or removed without notice.

Experimental features being actively developed before promotion to alpha.

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
| `media_player` | Speaker, Basic Video Player (TV) |
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
| [@codyc1515](https://github.com/codyc1515) | 🥇 **Top Reporter** - Climate/thermostat bugs (#52, #24, #21, #20), extensive testing feedback |
| [@Chrulf](https://github.com/Chrulf) | 🔍 Google Home brightness debugging (#41), detailed logs & testing |
| [@SH1FT-W](https://github.com/SH1FT-W) | 💎 **Sponsor** + Vacuum room selection feature request (#49) |
| [@depahk](https://github.com/depahk) | 📝 Migration documentation fix ([#32](https://github.com/RiDDiX/home-assistant-matter-hub/pull/32)) |
| [@Fettkeewl](https://github.com/Fettkeewl) | 🐛 Script import bug (#26), Alias feature request (#25) |
| [@razzietheman](https://github.com/razzietheman) | 💡 Feature requests: Preserve commissioned state (#31), alphabetical sorting (#30) |

### 📋 Issue Tracker - All Contributors

Thank you to everyone who helps improve this project by reporting issues!

| User | Issues | Type |
|------|--------|------|
| [@marksev1](https://github.com/marksev1) | [#62](https://github.com/RiDDiX/home-assistant-matter-hub/issues/62) | 💡 Aliases support |
| [@smacpi](https://github.com/smacpi) | [#60](https://github.com/RiDDiX/home-assistant-matter-hub/issues/60) | 💡 Battery sensor |
| [@semonR](https://github.com/semonR) | [#58](https://github.com/RiDDiX/home-assistant-matter-hub/issues/58) | 🐛 Dehumidifier |
| [@mrbluebrett](https://github.com/mrbluebrett) | [#53](https://github.com/RiDDiX/home-assistant-matter-hub/issues/53) | 🐛 Alexa duplicates |
| [@anpak](https://github.com/anpak) | [#45](https://github.com/RiDDiX/home-assistant-matter-hub/issues/45) | 💡 TV media player |
| [@alondin](https://github.com/alondin) | [#43](https://github.com/RiDDiX/home-assistant-matter-hub/issues/43) | 💡 Air Purifier |
| [@Chrulf](https://github.com/Chrulf) | [#41](https://github.com/RiDDiX/home-assistant-matter-hub/issues/41) | 🐛 Google brightness |
| [@Weske90](https://github.com/Weske90) | [#40](https://github.com/RiDDiX/home-assistant-matter-hub/issues/40) | 💡 Harmony remote |
| [@didiht](https://github.com/didiht) | [#37](https://github.com/RiDDiX/home-assistant-matter-hub/issues/37) | 🐛 Alexa brightness |
| [@Dixiland20](https://github.com/Dixiland20) | [#34](https://github.com/RiDDiX/home-assistant-matter-hub/issues/34) | 🐛 Somfy shutters |
| [@chromaxx7](https://github.com/chromaxx7) | [#29](https://github.com/RiDDiX/home-assistant-matter-hub/issues/29) | 🐛 Climate crash |
| [@Tomyk9991](https://github.com/Tomyk9991) | [#28](https://github.com/RiDDiX/home-assistant-matter-hub/issues/28) | 🐛 Heat/Cool startup |
| [@datvista](https://github.com/datvista) | [#27](https://github.com/RiDDiX/home-assistant-matter-hub/issues/27) | 🐛 Add-on start |
| [@bwynants](https://github.com/bwynants) | [#23](https://github.com/RiDDiX/home-assistant-matter-hub/issues/23) | 🐛 OccupancySensor |
| [@Pozzi831](https://github.com/Pozzi831) | [#22](https://github.com/RiDDiX/home-assistant-matter-hub/issues/22) | 🐛 AC problems |

### 💖 Sponsors

> **Donations are completely voluntary!** I'm incredibly grateful to everyone who has supported this project - it wasn't necessary, but it truly means a lot. This project exists because of passion for open source, not money. ❤️

| Sponsor | |
|---------|---|
| [@thorsten-gehrig](https://github.com/thorsten-gehrig) | 🥇 **First Sponsor!** Thank you for believing in this project! |
| [@SH1FT-W](https://github.com/SH1FT-W) | 💎 Thank you for your generous support! |
| *Anonymous supporters* | 🙏 Thank you to those who prefer not to be named - your support is equally appreciated! |

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
