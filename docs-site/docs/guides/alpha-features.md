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

Alpha is ahead of Stable (v2.0.59) with cooling temperatures that switch an Off thermostat to Cool, fans that pick up speed and direction added later, opt-in Block Off for thermostats and Product Name from Model for model names, a new unique ID after a factory reset, backup restore that keeps every mapping setting, room names that survive a failed Home Assistant query, a working `silly` log level, bridge port changes without an app restart, no downgrade offer on alpha, bridge pages ready for translation, a Vietnamese translation, and for robot vacuums Roborock error causes, Roborock jobs that survive a recharge, Vacuum & Mop on combined-only robots, one fan speed per Apple Home intensity and an opt-in readiness sensor. The web UI has a new sidebar shell, bridge import that applies without a restart and many fixes from a full review. A full code audit hardened the web API, made backups complete and restores safe, serialized bridge refreshes and cleaned up camera streams. Bridges wait for sensor group helpers to finish loading after a Home Assistant restart. A factory reset during pairing rolls the open pairing back first. A second code audit fixed pumps, Hue buttons, TV and speaker controls, water heaters, humidifiers, fan steps, sensor units, lock PINs, plugin installs and backup retention. Google voice colors reach lights that are already on. Fans on Auto show as on, and a setpoint set while a thermostat is Off resumes it, also on ZHA. Vacuum Dock ends a queued multi-room job, and lock PINs stay out of diagnostics and logs. The add-on can log in to Home Assistant as a user of your choice. A security review closed a cross-site gap behind same-host reverse proxies and a way past the backup size limit. Unpaired bridges reopen their pairing window after 48 hours, the configuration version follows added or removed devices, sessions that still carry live subscriptions stay open, and an incomplete refresh is retried. A non-admin Home Assistant token no longer causes an error per command, and changing the web UI password closes open live connections. See the alpha notes for each release. Standalone Devices graduated to Stable in v2.0.47, see [Standalone Devices](../getting-started/standalone-devices.md).

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
