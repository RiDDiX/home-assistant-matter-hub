# Home-Assistant-Matter-Hub

!["Home-Assistant-Matter-Hub"](./assets/hamh-logo-small.png)

---

> **Community Fork** - This is a fork of the original [t0bst4r/home-assistant-matter-hub](https://github.com/t0bst4r/home-assistant-matter-hub), which was discontinued in January 2026. We continue active development with bug fixes, new features, and community support.
>
> We actively work on fixing old issues from the original project and welcome new feature requests. This is a living project maintained by the community!

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

### Stable (v1.5.x)

- **Health Monitoring Dashboard** - Real-time bridge and fabric status monitoring
- **Automatic Recovery** - Auto-restart failed bridges
- **Bridge Wizard** - Guided setup for creating multiple bridges
- **AirQuality Sensors** - Support for AQI, PM2.5, PM10, CO2, and VOC sensors
- **Improved Fan Control** - Better speed control compatibility with Matter controllers
- **Media Player Playback** - Play/Pause/Stop/Next/Previous track controls

### Stable (v1.8.x) - NEW! 🎉

- **Graceful Crash Handler** - Failed entities no longer crash the bridge
  - Problematic entities are automatically skipped during boot
  - Failed entities are displayed in the UI with detailed error messages
  - Bridge continues to run with remaining healthy entities
- **PM2.5/PM10 Numeric Sensors** - Real concentration values in µg/m³
- **Access Control Fix** - Fixed attribute write issues ([Matter.js #3105](https://github.com/matter-js/matter.js/issues/3105))
- **Water Valve Support** - Control water valves via Matter
- **Smoke/CO Detector** - Binary sensors for smoke and CO alarms
- **Pressure/Flow Sensors** - Atmospheric pressure and flow measurements

### Stable (v1.9.0) - NEW! 🎉

All previous features plus:

**Bridge Icons & UI**
- **Custom Bridge Icons** - Upload your own PNG, JPG, GIF, WebP, or SVG icons
- **Domain-based Icons** - Automatic icon assignment based on bridge domain
- **20 Preset Icons** - Quick selection dropdown in bridge editor
- **Entity Mapping Button** - Quick access from bridge card view

**Media & Devices**
- **Basic Video Player** - TV and media player support for Apple Home
- **Alexa Deduplication** - UniqueId prevents duplicate devices

**Thermostat Improvements**
- **Auto-only Thermostat Support** - Thermostats with only "auto" mode now work
- **Heating+Cooling Fixes** - Proper Matter.js deadband handling
- **Google Home Fix** - Handle null transitionTime

**Infrastructure**
- **Health Check API** - REST endpoints for monitoring (`api/health`)
- **WebSocket Live Updates** - Real-time status updates (`api/ws`)
- **Ingress Compatibility** - Fixed routing for Home Assistant Ingress
- **Full Backup/Restore** - Complete backups including entity mappings
- **Entity Mapping** - Override Matter device types per entity
- **Filter Preview** - Preview entity matches before saving

### Alpha (v1.10.0-alpha)

All stable features plus experimental changes being actively developed.

See the [Alpha Features Guide](./Guides/Alpha%20Features.md) for detailed documentation.

## Getting started

To get things up and running, please follow the [installation guide](./Getting%20Started/Installation.md).

## Additional Resources

If you need more assistance on the topic, please have a look at the following external resources:

### Videos

#### YouTube-Video on "HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer" (🇩🇪)

[![HA Matter HUB/BRIDGE 😲 👉 Das ändert alles für ALEXA und GOOGLE Nutzer](https://img.youtube.com/vi/yOkPzEzuVhM/mqdefault.jpg)](https://www.youtube.com/watch?v=yOkPzEzuVhM)

#### YouTube-Video on "Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter" (🇫🇷)

[![Alexa et Google Home dans Home Assistant GRATUITEMENT grâce à Matter](https://img.youtube.com/vi/-TMzuHFo_-g/mqdefault.jpg)](https://www.youtube.com/watch?v=-TMzuHFo_-g)

## Support the Project

> **This is completely optional!** The project will continue regardless of donations.
> I maintain this in my free time because I believe in open source and helping the community.

If you find this project useful and want to support its development, consider buying me a coffee! ☕

[![PayPal](https://img.shields.io/badge/PayPal-Donate-blue?logo=paypal)](https://www.paypal.me/RiDDiX93)

Maintaining this project takes time and effort - from fixing bugs, adding new features, to helping users in issues.
Your support is appreciated but never expected. Thank you for using Home-Assistant-Matter-Hub! ❤️
