# Alpha Features Guide

This guide covers features available in the Alpha version (v1.10.0-alpha) of Home-Assistant-Matter-Hub.

> [!NOTE]
> **Most Alpha features are now in Stable!** With the v1.9.0 release, features like Health API, WebSocket, Entity Mapping, Backup/Restore, and Bridge Icons are now available in the stable version.

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

## Features Now in Stable (v1.9.0)

The following features have graduated from Alpha to Stable:

- **Custom Bridge Icons** - Upload PNG, JPG, GIF, WebP, SVG icons
- **Domain-based Icons** - Automatic icon assignment by domain
- **Health Check API** - REST endpoints for monitoring
- **WebSocket Live Updates** - Real-time bridge status
- **Entity Mapping** - Override Matter device types per entity
- **Full Backup/Restore** - Complete ZIP backups
- **Filter Preview** - Test filters before saving
- **Dark Mode** - Theme toggle in UI
- **Basic Video Player** - TV support for Apple Home
- **Thermostat Improvements** - Auto-only mode, heating+cooling fixes
- **Ingress Compatibility** - Fixed routing for HA Ingress

---

## Current Alpha Features (v1.10.0-alpha)

Alpha currently contains all stable features. New experimental features will be added here before being promoted to stable.

---

## Reference: Feature Documentation

The following sections document features that are now in stable but provide detailed usage instructions.

### 1. Full Backup & Restore System

Create complete backups of your configuration as ZIP files, including all bridges and entity mappings.

**Features:**
- Download complete backup as ZIP file
- Includes bridge configurations and entity mappings
- Selective restore - choose which bridges to restore
- Option to overwrite existing bridges
- Preview backup contents before restoring

**Using Backup:**
1. Go to the Bridges page
2. Click **Download Backup** to create a ZIP backup
3. To restore, click **Restore from Backup** and select a ZIP file
4. Preview the contents and select which bridges to restore
5. Choose options (overwrite existing, include mappings)
6. Click **Restore**

### 2. Filter Preview

Preview which entities will match your filter configuration before saving.

**Features:**
- Test filters without saving changes
- See matching entity count
- View entity names and domains
- Identify included/excluded entities

### 3. Smoke/CO Detector Support

Binary sensors with `smoke`, `carbon_monoxide`, or `gas` device class are now mapped to Matter Smoke CO Alarm devices.

**Supported Device Classes:**
- `smoke` - Smoke detector
- `carbon_monoxide` - CO detector  
- `gas` - Gas detector

### 4. Dark Mode Toggle

Switch between light and dark themes directly from the UI.

**Using Dark Mode:**
- Click the sun/moon icon in the top navigation bar
- Theme preference is saved in your browser

### 5. Device List Sorting

Sort the endpoint/device list by different criteria.

**Sort Options:**
- **Name** - Alphabetical by device name
- **Endpoint ID** - Numerical by Matter endpoint ID
- **Type** - Grouped by device type

### 6. Health Monitoring Dashboard

The Health Dashboard provides real-time monitoring of your bridges and fabric connections.

**Accessing the Dashboard:**
- Click the heart icon (❤️) in the top navigation bar
- Or navigate to `/health` in your browser

**Features:**
- **System Overview**: Version, uptime, and Home Assistant connection status
- **Bridge Status**: Real-time status of all bridges (running, stopped, failed)
- **Fabric Connections**: See which controllers (Google, Apple, Alexa, Samsung) are connected
- **Device Count**: Number of devices per bridge
- **Recovery Status**: View auto-recovery attempts and status

### 2. Automatic Bridge Recovery

Failed bridges are automatically restarted to ensure maximum uptime.

**How it works:**
- The system monitors bridge health every 30 seconds
- Failed bridges are automatically restarted
- Recovery attempts are logged and visible in the Health Dashboard
- Configurable recovery intervals prevent restart loops

**Recovery Status Indicators:**
- 🟢 **Running**: Bridge is healthy
- 🟡 **Starting**: Bridge is initializing
- 🔴 **Failed**: Bridge has failed (auto-recovery will attempt restart)
- ⚪ **Stopped**: Bridge is manually stopped

### 3. Bridge Wizard

The Bridge Wizard simplifies creating multiple bridges with automatic configuration.

**Using the Wizard:**
1. Go to the Bridges page
2. Click the **Wizard** button
3. Follow the guided steps:
   - Enter bridge name
   - Select entities using filters
   - Port is automatically assigned
4. Create multiple bridges in one session
5. Review and confirm before creation

**Automatic Port Assignment:**
- Starting port: 5540 (Alexa-compatible)
- Each new bridge gets the next available port
- Prevents port conflicts automatically

### 4. Water Valve Support

Control water valves through Matter.

**Supported Features:**
- Open/Close valve control
- Current position status
- Works with Home Assistant `valve` domain entities

**Controller Support:**
- Apple Home: ✅ Supported
- Google Home: ⚠️ Limited support
- Alexa: ⚠️ Limited support

### 5. Health Check API

REST API endpoints for monitoring and Kubernetes integration.

**Endpoints:**

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Basic health status |
| `GET /api/health/detailed` | Detailed status with bridge info |
| `GET /api/health/live` | Kubernetes liveness probe |
| `GET /api/health/ready` | Kubernetes readiness probe |

**Example Response (`/api/health`):**
```json
{
  "status": "healthy",
  "version": "2.0.0-alpha.1",
  "uptime": 3600,
  "services": {
    "homeAssistant": { "connected": true },
    "bridges": { "total": 2, "running": 2, "failed": 0 }
  }
}
```

### 6. WebSocket Live Updates

Real-time updates without polling.

**Connecting:**
```javascript
const ws = new WebSocket('ws://your-hamh-host:8482/api/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Update:', data);
};
```

**Event Types:**
- `bridge:status` - Bridge status changes
- `bridge:devices` - Device count changes
- `fabric:connected` - New fabric connection
- `fabric:disconnected` - Fabric disconnected

### 7. Entity Mapping Customization

Override Matter device types and names per entity.

**Use Cases:**
- Force a specific Matter device type
- Custom names for entities in Matter
- Disable specific entities from a bridge

---

## Tips for Alpha Testing

### 1. Backup Your Data

Before upgrading to Alpha, backup your configuration:

```bash
# Docker
cp -r /path/to/data /path/to/data-backup

# Home Assistant Add-on
# Data is stored in /config/home-assistant-matter-hub
```

### 2. Run Alpha Separately

You can run both Stable and Alpha versions simultaneously:
- Use different ports (e.g., 8482 for stable, 8483 for alpha)
- Use different data directories
- Use different Matter ports for bridges

### 3. Reporting Issues

When reporting Alpha issues, please include:
- Alpha version number
- Logs from the add-on/container
- Steps to reproduce the issue
- Controller type (Google, Apple, Alexa)

### 4. Common Alpha Issues

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

## Configuration Tips

### Optimal Bridge Setup

```json
{
  "name": "Living Room",
  "port": 5540,
  "filter": {
    "include": [
      { "type": "area", "value": "living_room" }
    ],
    "exclude": [
      { "type": "entity_category", "value": "diagnostic" },
      { "type": "entity_category", "value": "config" }
    ]
  }
}
```

### Multiple Bridges Strategy

1. **By Area**: One bridge per room/area
2. **By Controller**: Separate bridges for different ecosystems
3. **By Device Type**: Group similar devices together

### Performance Recommendations

- **Max devices per bridge**: 50-80 for Alexa, 100+ for others
- **Separate vacuum devices**: Put vacuums in their own bridge
- **Monitor health**: Use the Health Dashboard to track issues

---

## Reverting to Stable

If you encounter issues with Alpha:

1. Stop the Alpha add-on/container
2. Install the Stable version
3. Your paired devices should reconnect automatically
4. Some new features may not be available

> [!NOTE]
> Configuration data is compatible between versions. Your bridges and settings will be preserved.

---

## Acknowledgments

Special thanks to the community members who help improve this project by reporting issues and providing detailed information:

- **[@codyc1515](https://github.com/codyc1515)** - For reporting the Apple Home "Not Responding" issue with lights ([#5](https://github.com/RiDDiX/home-assistant-matter-hub/issues/5)), which helped identify and fix the `CurrentLevel` null value problem affecting controller compatibility.
