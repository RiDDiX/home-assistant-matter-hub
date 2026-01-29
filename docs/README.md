# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](./assets/hamh-logo-small.png)

---

This project simulates bridges to publish your entities from Home Assistant to any Matter-compatible controller like
Alexa, Apple Home or Google Home. Using Matter, those can be connected easily using local communication without the need
of port forwarding etc.

---

## Known issues and limitations

### Device Type Support

This project does not yet support all available device types in the matter specification.
In addition, controllers like Alexa or Google Home do not support all device types, too.

To check which types are supported, please review the
[list of supported device types](./Supported%20Device%20Types.md).

### Alexa

- Alexa cannot pair with a bridge which has too many devices attached. It seems to have a limit of
  about 80-100 devices
- Alexa needs at least one Amazon device which supports Matter to pair with a Matter device.
  If you only have a third party smart speaker which supports Alexa, this isn't enough.

### Google Home

- Google Home needs an actual Google Hub to connect a Matter device. Just using the GH app isn't enough.
- Google Home can deny the Matter device under certain conditions because it is not a certified Matter
  device. You need to follow
  [this guide](https://github.com/project-chip/matter.js/blob/main/docs/ECOSYSTEMS.md#google-home-ecosystem)
  to register your hub.

### Network setup

The Matter protocol is designed to work best with UDP and IPv6 within your local network. At the moment some
manufacturers built their controllers to be compatible with IPv4, too, but this can break at any time with any update.

Many users report connection issues when using VLANs or firewalls, where HAMH and the assistant devices (Alexa, Google
Home, ...) are not placed in the same network segment. Please make sure to review the
[common connectivity issues](./Guides/Connectivity%20Issues.md).

## What's New

### Stable (v1.7.x - v1.8.x)

- **Health Monitoring Dashboard** - Real-time bridge and fabric status monitoring
- **Automatic Recovery** - Auto-restart failed bridges
- **Bridge Wizard** - Guided setup for creating multiple bridges
- **AirQuality Sensors** - Support for AQI, PM2.5, PM10, CO2, and VOC sensors
- **Improved Fan Control** - Better speed control compatibility with Matter controllers
- **Media Player Playback** - Play/Pause/Stop/Next/Previous track controls
- **Graceful Crash Handler** - Failed entities no longer crash the bridge
- **Dark Mode Toggle** - Switch between light and dark theme
- **Device List Sorting** - Sort endpoints by name, type, or ID
- **Water Valve Support** - Control water valves via Matter
- **Smoke/CO Detector** - Binary sensors for smoke and carbon monoxide alarms
- **Pressure & Flow Sensors** - Atmospheric pressure and flow rate measurements
- **Air Purifier & Pump** - New device type mappings via entity mapping

### Alpha (v2.0.0-alpha)

All stable features plus:

#### APIs & Backend
- **Health Check API** (`/api/health`, `/api/health/detailed`) - System status and Kubernetes-ready probes
- **System Info API** (`/api/system/info`) - CPU, memory, storage, network info
- **Logs API** (`/api/logs`) - Retrieve, filter, search, and clear application logs
- **Metrics API** (`/api/metrics`) - Prometheus-compatible metrics endpoint
- **WebSocket Live Updates** (`/api/ws`) - Real-time bridge status updates

#### UI Enhancements
- **System Information Panel** - Real-time system stats in Health page
- **Log Viewer Dialog** - View, filter, and search logs from the UI
- **Entity Mapping Customization** - Override Matter device types per entity
- **Filter Preview** - Preview which entities match your filter before saving
- **Alphabetical Bridge Sorting** - Bridges sorted by name in UI

#### Backup & Restore
- **Full Backup/Restore** - Download complete backups as ZIP including entity mappings
- **Full Backup with Identity** - Preserve Matter commissioning across reinstalls (no re-pairing needed!)

### Testing (v4.0.0-testing) ⚠️

> **Warning:** Testing versions may contain BREAKING CHANGES and are intended for developers only!

All alpha features plus experimental Matter.js updates and cutting-edge features.

See the [API Documentation](./Guides/API%20Reference.md) for detailed API endpoints.

## Getting started

To get things up and running, please follow the [installation guide](./Getting%20Started/Installation.md).

## Additional Resources

If you need more assistance on the topic, please have a look at the following external resources:

### Videos

#### YouTube-Video on "HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer" (🇩🇪)

[![HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer](https://img.youtube.com/vi/yOkPzEzuVhM/mqdefault.jpg)](https://www.youtube.com/watch?v=yOkPzEzuVhM)

#### YouTube-Video on "Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter" (🇫🇷)

[![Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter](https://img.youtube.com/vi/-TMzuHFo_-g/mqdefault.jpg)](https://www.youtube.com/watch?v=-TMzuHFo_-g)
