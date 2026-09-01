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

Alpha is ahead of Stable (v2.0.56): editing the entity filter removes and adds endpoints right away instead of riding the five minute restart grace, and re-including an entity brings the device back with its groups ([#468](https://github.com/RiDDiX/home-assistant-matter-hub/issues/468)); the new `omitEventsInPriming` bridge option sends the initial subscription report without stored events, for Google fabrics whose devices never come online ([#424](https://github.com/RiDDiX/home-assistant-matter-hub/issues/424)) (alpha.886); a device renamed in Home Assistant reaches the controller without a restart ([#467](https://github.com/RiDDiX/home-assistant-matter-hub/issues/467)) (alpha.885); the new `composedPrimaryOnParent` bridge option lets a grouped device announce its own device type, so Apple Home shows the right icon ([#469](https://github.com/RiDDiX/home-assistant-matter-hub/issues/469)) (alpha.884); a controller that refuses the bridge certificates is named in the log; certified-only controllers such as the Philips Ambiscape feature cannot pair at all with the matter.js test certificates ([#465](https://github.com/RiDDiX/home-assistant-matter-hub/issues/465)) (alpha.883); lock PINs take effect immediately, credentials respect Add, Modify and the fabric that created them, programming a physical lock is confirmed before success is reported, and credential files are read defensively (alpha.882); locks reject an empty or overlong PIN and PIN hashing moved off the event loop (alpha.881); state writes wait for the endpoint lock instead of being dropped when several entities update at once ([#464](https://github.com/RiDDiX/home-assistant-matter-hub/issues/464)) (alpha.880); composed air purifiers list their battery entity and a classless sensor needs "batt" in its id, so the endpoint stops rebuilding itself on every sensor update ([#461](https://github.com/RiDDiX/home-assistant-matter-hub/issues/461)); endpoint state writes are serialized, so covers moved together no longer lose their position ([#464](https://github.com/RiDDiX/home-assistant-matter-hub/issues/464)); `alexaPreserveBrightnessOnTurnOn` only suppresses the brightness reset on the Alexa fabric, Siri's "set to 100%" works again ([#460](https://github.com/RiDDiX/home-assistant-matter-hub/issues/460)); the new per-entity `climateForceTurnOn` always sends `climate.turn_on` for IR controlled ACs ([#462](https://github.com/RiDDiX/home-assistant-matter-hub/issues/462)) (alpha.879); covers keep a stable Matter attribute list across restarts ([#456](https://github.com/RiDDiX/home-assistant-matter-hub/issues/456)) (alpha.878); the add-on heap limit is configurable via `heap_size_mb` and sizes to 50% of available memory ([#459](https://github.com/RiDDiX/home-assistant-matter-hub/issues/459)) (alpha.877); third-party plugins load through their manifest entry point, plugin devices carry their own name on controllers, and plugin topology changes are announced to commissioned controllers ([#458](https://github.com/RiDDiX/home-assistant-matter-hub/pull/458)) (alpha.876); the security plugin can mirror an existing Home Assistant alarm panel via the new `sourceAlarmPanel` setting ([#457](https://github.com/RiDDiX/home-assistant-matter-hub/pull/457)) (alpha.875). Standalone Devices graduated to Stable in v2.0.47, see [Standalone Devices](../getting-started/standalone-devices.md).

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
