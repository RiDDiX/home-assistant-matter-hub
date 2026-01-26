# Migration from t0bst4r to RiDDiX Fork

This guide explains how to migrate from the original `t0bst4r/home-assistant-matter-hub` to the `riddix/home-assistant-matter-hub` fork **without losing your Matter fabric connections**.

:::{important}
The storage format is fully compatible between both versions. Your Matter fabric data (connections to Apple Home, Google Home, Alexa, etc.) will be preserved.
:::

## Prerequisites

- Backup your current configuration before starting
- Note your current bridge settings (port, filters, etc.)

## Migration Methods

### Method 1: Home Assistant Add-on (Recommended)

#### Step 1: Backup Storage Data

1. Access your Home Assistant via SSH or Terminal
2. Copy the storage directory:
   ```bash
   cp -r /addon_configs/*/home-assistant-matter-hub /config/hamh-backup
   ```

#### Step 2: Uninstall Old Add-on

1. Go to **Settings → Add-ons → Home Assistant Matter Hub**
2. Click **Uninstall**
3. **Important:** Do NOT remove the backup yet

#### Step 3: Add RiDDiX Repository

1. Go to **Settings → Add-ons → Add-on Store**
2. Click the three dots (⋮) → **Repositories**
3. Add: `https://github.com/riddix/home-assistant-addons`
4. Click **Add** → **Close**

#### Step 4: Install New Add-on

1. Find **Home-Assistant-Matter-Hub** in the store (by RiDDiX)
2. Click **Install**
3. **Before starting**, restore the backup:
   ```bash
   cp -r /config/hamh-backup/* /addon_configs/*/home-assistant-matter-hub/
   ```

#### Step 5: Configure and Start

1. Copy your previous configuration settings
2. Start the add-on
3. Your Matter fabrics should reconnect automatically

---

### Method 2: Docker

#### Step 1: Stop Current Container

```bash
docker stop home-assistant-matter-hub
```

#### Step 2: Backup Storage

```bash
# Default location
cp -r ~/.home-assistant-matter-hub ~/.home-assistant-matter-hub-backup

# Or your custom storage location
cp -r /path/to/storage /path/to/storage-backup
```

#### Step 3: Update Container Image

```bash
# Remove old container (keeps volumes)
docker rm home-assistant-matter-hub

# Pull new image
docker pull ghcr.io/riddix/home-assistant-matter-hub:latest

# Start with same configuration
docker run -d \
  --name home-assistant-matter-hub \
  --network host \
  -v ~/.home-assistant-matter-hub:/data \
  -e HAMH_HOME_ASSISTANT_URL="http://homeassistant.local:8123" \
  -e HAMH_HOME_ASSISTANT_ACCESS_TOKEN="your-token" \
  ghcr.io/riddix/home-assistant-matter-hub:latest
```

#### Step 4: Verify

Your Matter connections should work immediately without recommissioning.

---

### Method 3: Docker Compose

#### Step 1: Update `docker-compose.yml`

Change the image from:
```yaml
image: ghcr.io/t0bst4r/home-assistant-matter-hub:latest
```

To:
```yaml
image: ghcr.io/riddix/home-assistant-matter-hub:latest
```

#### Step 2: Restart

```bash
docker compose down
docker compose pull
docker compose up -d
```

---

## Troubleshooting

### Fabrics Not Reconnecting

If your Matter controllers don't reconnect:

1. **Wait 2-3 minutes** - Matter devices may need time to re-establish connections
2. **Check logs** for errors:
   ```bash
   # Add-on
   ha addon logs hamh

   # Docker
   docker logs home-assistant-matter-hub
   ```
3. **Restart your Matter controller** (Apple Home, Google Home app, etc.)

### Storage Permission Issues

If you see permission errors:

```bash
# Fix permissions (adjust path as needed)
sudo chown -R $(whoami):$(whoami) ~/.home-assistant-matter-hub
```

### Configuration Differences

The RiDDiX fork is fully backwards-compatible with t0bst4r configuration. New features (like `--json-logs`) are optional.

---

## What's Different in the RiDDiX Fork?

| Feature | t0bst4r | RiDDiX |
|---------|---------|--------|
| Pressure Sensor | ❌ | ✅ |
| Flow Sensor | ❌ | ✅ |
| Air Quality Sensor | ❌ | ✅ |
| Valve Support | ❌ | ✅ |
| Alarm Control Panel | ❌ | ✅ |
| Structured JSON Logging | ❌ | ✅ |
| Improved UI | ❌ | ✅ |

See the [README](https://github.com/riddix/home-assistant-matter-hub#releases) for the full changelog.

---

## Rollback

If you need to rollback to t0bst4r:

1. Stop the RiDDiX version
2. Restore your backup
3. Reinstall the original add-on/container
4. Your fabrics should still work (storage format is identical)
