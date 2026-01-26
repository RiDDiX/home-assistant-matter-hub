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
> **📦 Migrating from t0bst4r's version?** See our [Migration Guide](https://riddix.github.io/home-assistant-matter-hub/migration-from-t0bst4r) - your existing configuration and paired devices will continue to work!

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
| `sensor` | Temperature, Humidity, Pressure, Light, AirQuality Sensor |
| `button`, `input_button` | Generic Switch |
| `media_player` | Speaker with Volume and Playback Controls |
| `valve` | Water Valve (Alpha only) |
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
