# API Reference

This document describes the REST API endpoints available in the Alpha and Testing versions of Home-Assistant-Matter-Hub.

> **Note:** These APIs are available starting from version **2.0.0-alpha.x**. Stable versions may not include all endpoints.

## Base URL

When using Home Assistant Ingress, all API endpoints are relative to the ingress URL:
```
/api/hassio_ingress/<ingress_token>/api/...
```

For standalone Docker deployments:
```
http://localhost:8482/api/...
```

---

## Health API

### GET /api/health

Returns basic health status of the application.

**Response:**
```json
{
  "status": "healthy",
  "version": "2.0.0-alpha.65",
  "uptime": 3600
}
```

### GET /api/health/detailed

Returns detailed health information including bridge status.

**Response:**
```json
{
  "status": "healthy",
  "version": "2.0.0-alpha.65",
  "uptime": 3600,
  "bridges": [
    {
      "id": "bridge-1",
      "name": "My Bridge",
      "status": "running",
      "deviceCount": 25,
      "fabricCount": 2
    }
  ],
  "homeAssistant": {
    "connected": true,
    "url": "http://homeassistant.local:8123"
  }
}
```

### GET /api/health/live

Kubernetes liveness probe. Returns 200 if the application is running.

### GET /api/health/ready

Kubernetes readiness probe. Returns 200 if all bridges are ready.

---

## System Info API

### GET /api/system/info

Returns detailed system information.

**Response:**
```json
{
  "version": "2.0.0-alpha.65",
  "nodeVersion": "v24.13.0",
  "hostname": "homeassistant",
  "platform": "linux",
  "arch": "x64",
  "uptime": 86400,
  "cpuCount": 4,
  "loadAvg": [0.5, 0.3, 0.2],
  "memory": {
    "total": 8589934592,
    "used": 4294967296,
    "free": 4294967296,
    "usagePercent": 50.0
  },
  "network": {
    "interfaces": [
      {
        "name": "eth0",
        "address": "192.168.1.100",
        "family": "IPv4",
        "mac": "aa:bb:cc:dd:ee:ff",
        "internal": false
      }
    ]
  },
  "storage": {
    "total": 107374182400,
    "used": 53687091200,
    "free": 53687091200,
    "usagePercent": 50.0
  },
  "process": {
    "pid": 1234,
    "uptime": 3600,
    "memoryUsage": 134217728
  }
}
```

---

## Logs API

### GET /api/logs

Retrieves application logs with optional filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | string | `error,warn,info` | Comma-separated log levels to include |
| `limit` | number | `100` | Maximum number of entries to return |
| `search` | string | - | Search term to filter log messages |

**Example:**
```
GET /api/logs?level=error,warn&limit=500&search=bridge
```

**Response:**
```json
{
  "entries": [
    {
      "timestamp": "2026-01-29T00:30:00.000Z",
      "level": "info",
      "message": "Bridge started successfully",
      "context": {
        "bridgeId": "bridge-1"
      }
    }
  ]
}
```

### DELETE /api/logs

Clears all stored log entries.

**Response:**
```json
{
  "success": true
}
```

### GET /api/logs/stream

Server-Sent Events (SSE) endpoint for real-time log streaming.

**Example:**
```javascript
const eventSource = new EventSource('/api/logs/stream');
eventSource.onmessage = (event) => {
  const log = JSON.parse(event.data);
  console.log(log);
};
```

---

## Metrics API

### GET /api/metrics

Returns Prometheus-compatible metrics.

**Response:**
```
# HELP hamh_bridges_total Total number of bridges
# TYPE hamh_bridges_total gauge
hamh_bridges_total 3

# HELP hamh_devices_total Total number of devices
# TYPE hamh_devices_total gauge
hamh_devices_total 75

# HELP hamh_uptime_seconds Application uptime in seconds
# TYPE hamh_uptime_seconds gauge
hamh_uptime_seconds 3600
```

---

## Backup API

### GET /api/backup/download

Downloads a backup ZIP file containing bridge configurations and entity mappings.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeIdentity` | boolean | `false` | Include Matter identity files (keypairs, fabric credentials) |

**Example:**
```
GET /api/backup/download?includeIdentity=true
```

**Response:** ZIP file download

### POST /api/backup/restore/preview

Uploads a backup file and returns a preview of what would be restored.

**Request:** `multipart/form-data` with `file` field containing the ZIP file

**Response:**
```json
{
  "version": 1,
  "createdAt": "2026-01-29T00:00:00.000Z",
  "includesIdentity": true,
  "bridges": [
    {
      "id": "bridge-1",
      "name": "My Bridge",
      "port": 5540,
      "exists": false,
      "hasMappings": true,
      "mappingCount": 15
    }
  ]
}
```

### POST /api/backup/restore

Restores bridges and entity mappings from an uploaded backup.

**Request:** `multipart/form-data` with:
- `file`: ZIP file
- `options`: JSON string with restore options

**Options:**
```json
{
  "bridgeIds": ["bridge-1", "bridge-2"],
  "overwriteExisting": false,
  "includeMappings": true,
  "restoreIdentity": true
}
```

**Response:**
```json
{
  "bridgesRestored": 2,
  "bridgesSkipped": 0,
  "mappingsRestored": 30,
  "identitiesRestored": 2,
  "errors": [],
  "restartRequired": true
}
```

---

## WebSocket API

### WS /api/ws

WebSocket endpoint for real-time updates.

**Message Types:**

#### Bridge Status Update
```json
{
  "type": "bridge:status",
  "data": {
    "id": "bridge-1",
    "status": "running",
    "deviceCount": 25
  }
}
```

#### Health Update
```json
{
  "type": "health:update",
  "data": {
    "status": "healthy",
    "uptime": 3600
  }
}
```

---

## Entity Mappings API

### GET /api/entity-mappings

Returns all entity mapping customizations.

### GET /api/entity-mappings/:entityId

Returns mapping for a specific entity.

### PUT /api/entity-mappings/:entityId

Updates mapping for a specific entity.

**Request:**
```json
{
  "deviceType": "AirPurifier",
  "name": "Custom Name",
  "disabled": false
}
```

### DELETE /api/entity-mappings/:entityId

Removes custom mapping for an entity.

---

## Home Assistant API

### GET /api/home-assistant/entities

Returns all entities from Home Assistant.

### GET /api/home-assistant/devices

Returns all devices from Home Assistant.

### GET /api/home-assistant/areas

Returns all areas from Home Assistant.
