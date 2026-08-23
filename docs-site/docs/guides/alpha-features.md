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

Alpha is ahead of Stable (v2.0.55). The alpha channel currently carries, newest first:

- Korean translation (alpha.874)
- PM2.5, PM10 and CO₂ sensor overrides in the Entity Mapping UI (alpha.872)
- RGB-only lights such as WLED advertise the full Extended Color Light feature set again, so Alexa keeps them ([#452](https://github.com/RiDDiX/home-assistant-matter-hub/issues/452)) (alpha.871)
- Thermostat bring-up with a flat heat range no longer trips the range check ([#454](https://github.com/RiDDiX/home-assistant-matter-hub/issues/454)) (alpha.871)
- Debounced commands keep an explicit on/off next to a level change ([#453](https://github.com/RiDDiX/home-assistant-matter-hub/pull/453)) (alpha.870)
- Vacuum battery and charge state after the HA 2026.8 battery sensor split ([#450](https://github.com/RiDDiX/home-assistant-matter-hub/issues/450)) (alpha.869)
- Three Alexa pairing diagnostic flags, off by default: `advertiseSpecVersion151`, `supportTermsAndConditions`, `enableMatterTcp` ([#449](https://github.com/RiDDiX/home-assistant-matter-hub/issues/449)) (alpha.866 to alpha.868)
- Cover end product type follows the feature map, follow-up to [#304](https://github.com/RiDDiX/home-assistant-matter-hub/issues/304) (alpha.865)

The full list with details lives in the [What's New](../index.md#whats-new) section. Standalone Devices graduated to Stable in v2.0.47, see [Standalone Devices](../getting-started/standalone-devices.md).

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
