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

## Releases

| Channel | Version | Description |
|---------|---------|-------------|
| **Stable** | ![GitHub Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?label=stable) | Production-ready, recommended for most users |
| **Alpha** | ![GitHub Release](https://img.shields.io/github/v/release/RiDDiX/home-assistant-matter-hub?include_prereleases&label=alpha) | Pre-release with new features, for testing |

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

### Alpha Features (v2.0.0-alpha) 🧪

> [!WARNING]
> Alpha versions are for testing only and may contain bugs!

All stable features plus:

- **Water Valve Support** - Control water valves via Matter
- **Health Check API** (`/api/health`) - System status, uptime, Kubernetes probes
- **WebSocket Live Updates** (`/api/ws`) - Real-time bridge status
- **Entity Mapping Customization** - Override Matter device types per entity

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
| `binary_sensor` | Contact Sensor, Occupancy Sensor |
| `sensor` | Temperature, Humidity, Pressure, Flow, Light, Air Quality Sensor |
| `button`, `input_button` | Generic Switch |
| `media_player` | Speaker with Volume and Playback Controls |
| `vacuum` | Robot Vacuum Cleaner |
| `humidifier` | Humidifier/Dehumidifier |
| `valve` | Water Valve (Alpha) |
| `alarm_control_panel` | On/Off Plug-in Unit (Alpha) |
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

4. **Install new add-on** and restore backup before starting:
   ```bash
   ls /addon_configs/  # Find new _hamh folder
   cp -r /config/hamh-backup/* /addon_configs/*_hamh/
   ```

5. **Start the add-on** - your devices should reconnect automatically

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
