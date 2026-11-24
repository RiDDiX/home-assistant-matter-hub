# Alpha Features Guide

This guide covers how to install and use the Alpha version of Home-Assistant-Matter-Hub.

> [!WARNING]
> Alpha versions are for testing only and may contain bugs. Use at your own risk!

## Installing the Alpha Version

### Home Assistant Add-on

1. Add the repository: `https://github.com/riddix/home-assistant-addons`
2. Install **Home-Assistant-Matter-Hub (Alpha)** from the Add-on Store
3. The Alpha add-on runs independently from the stable version

### Docker

Use the `alpha` tag instead of `latest`:

```bash
docker run -d \
  --name home-assistant-matter-hub-alpha \
  --network host \
  -v /path/to/data:/data \
  -e HAMH_HOME_ASSISTANT_URL=http://homeassistant.local:8123 \
  -e HAMH_HOME_ASSISTANT_ACCESS_TOKEN=your_token \
  ghcr.io/riddix/home-assistant-matter-hub:alpha
```

---

## Current Alpha Features

Alpha is ahead of Stable (v2.0.60). A vacuum with room switches that disappears from Home Assistant no longer breaks bridge refreshes during its removal grace, an entity with a very long custom name gets a shorter endpoint id and mounts, and with Stable device identity a new entity that takes the old entity id of a renamed one gets its own identity. The alpha add-on has a switch `allow_local_access` that lets programs on the Home Assistant host, for example a custom integration, reach the add-on API, with an optional `local_api_password`. A vacuum whose mode selects go unavailable, as seen with Dreame, keeps its mop modes and shows no made-up fan speed or mop level. A fan or air purifier that is unavailable at start keeps its last speed range and filter condition. A paired bridge waits for Home Assistant after a host reboot instead of starting empty. A light that was unavailable at start gets its full type once Home Assistant reports its color modes, and a command Home Assistant refuses no longer counts toward blocking the entity. Removing the bridge from the last controller no longer crashes the app when the Matter port is taken at that moment, and mDNS no longer warns about Docker interfaces at start. The add-on stops with a clear message when `/config` is not mapped to the Home Assistant host instead of starting on empty storage. A climate shown as Room Air Conditioner keeps its power state in sync with Home Assistant when the entity has no on/off support or `disableClimateOnOff` or `climateBlockOff` is set. With `preferEntityAlias` on a bridge, the first Home Assistant alias of an entity becomes its Matter device name. The security plugin replays the alerts of a trip that happened during a Home Assistant connection gap while the alarm is still triggered. Locks clear the PIN on the physical keypad when a controller removes a user whose PIN was disabled in the web UI. The Home Assistant API routes and the bridge device list return `[redacted]` for camera `access_token` and `entity_picture`. The app stops at start when only one of the HTTP login username and password is set. Regex filter rules get a 2 second budget, so a slow pattern no longer freezes the app. A vacuum that was unavailable at endpoint build gets its rooms once they arrive. Without a login, the web UI and API of a standalone or Docker install only answer on the machine itself, through Home Assistant ingress and for whitelisted addresses. A backup restore stages its files first and puts the old ones back when a step fails, and app-wide data such as the web login and lock credentials is only restored on request. Matter log lines show `[redacted]` for PINs and keys. A paired bridge waits up to 30 seconds for a device whose Home Assistant state is late instead of going online without it, and a failed factory reset keeps the device identities. The routine session cleanup after a controller drops its session is logged at INFO. A paired bridge also waits up to 30 seconds for a device that failed to start, and a device class filter keeps the last known class while a state is missing. A changed cover percentage flag reaches the controllers when the bridge is saved, and the cover chip in the web UI follows the cover flags. Humidity and pressure no longer share the endpoint of a temperature sensor: each reading is its own device, and the bridge warns when a setting keeps one of them out. Behind a reverse proxy that removes a sub-path, `X-Forwarded-Prefix` is the header for that sub-path and wins over `X-Ingress-Path`, such requests no longer get a 400, and query strings through ingress stay intact. The sub-path header must be a plain path, and with `--http-base-path` behind such a proxy, opening `/` redirects inside the proxy's sub-path. See the alpha notes for each release. Standalone Devices graduated to Stable in v2.0.47, see [Standalone Devices](../getting-started/standalone-devices.md).

For a complete list of all supported features and device types, see [Supported Device Types](../supported-device-types.md).

---

## Tips for Alpha Testing

### Backup Your Data

Before upgrading to Alpha, backup your configuration:

```bash
# Docker
cp -r /path/to/data /path/to/data-backup

# Home Assistant Add-on
# Data is stored in /config/home-assistant-matter-hub
```

### Run Alpha Separately

You can run both Stable and Alpha versions simultaneously:
- Use different ports (e.g., 8482 for stable, 8483 for alpha)
- Use different data directories
- Use different Matter ports for bridges

### Reporting Issues

When reporting Alpha issues, please include:
- Alpha version number
- Logs from the add-on/container
- Steps to reproduce the issue
- Controller type (Google, Apple, Alexa)

### Common Alpha Issues

**Bridge not starting:**
- Check logs for specific errors
- Verify port is not in use
- Try factory reset of the bridge

**Entities not appearing:**
- Verify filter configuration
- Check entity is supported
- Review logs for errors during device creation

**Controller not connecting:**
- Ensure IPv6 is enabled
- Check mDNS/UDP routing
- Verify port is accessible

---

## Reverting to Stable

If you encounter issues with Alpha:

1. Stop the Alpha add-on/container
2. Install the Stable version
3. Your paired devices should reconnect automatically
4. Some new features may not be available

> [!NOTE]
> Configuration data is compatible between versions. Your bridges and settings will be preserved.
