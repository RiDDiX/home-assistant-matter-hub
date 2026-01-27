# Home Assistant Matter Hub - REST API Documentation

> ⚠️ **Note:** This API is currently only available in the **Alpha branch**. It will be migrated to the stable (main) branch in a future release.

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Base URL](#base-url)
- [API Endpoints](#api-endpoints)
  - [Health API](#health-api)
  - [Matter/Bridge API](#matterbridge-api)
  - [Home Assistant API](#home-assistant-api)
  - [Entity Mapping API](#entity-mapping-api)
  - [Bridge Export/Import API](#bridge-exportimport-api)
  - [Backup API](#backup-api)
  - [Logs API](#logs-api)
  - [Metrics API](#metrics-api)
  - [WebSocket API](#websocket-api)

---

## Overview

The Home Assistant Matter Hub provides a comprehensive REST API for managing bridges, entities, and monitoring system health. All endpoints return JSON unless otherwise specified.

## Authentication

If configured, the API uses HTTP Basic Authentication. Set credentials via environment variables or configuration file.

## Base URL

```
http://<host>:<port>/api
```

Default port: `8482`

---

## API Endpoints

### Health API

Base path: `/api/health`

#### GET /health
Returns basic health status of the application.

**Response:**
```json
{
  "status": "healthy" | "degraded" | "unhealthy",
  "version": "2.0.0-alpha.21",
  "uptime": 3600,
  "timestamp": "2026-01-27T12:00:00.000Z",
  "services": {
    "homeAssistant": {
      "connected": true
    },
    "bridges": {
      "total": 2,
      "running": 2,
      "stopped": 0,
      "failed": 0
    }
  }
}
```

**Status Codes:**
- `200` - Healthy or degraded
- `503` - Unhealthy

#### GET /health/detailed
Returns detailed health information including bridge details.

**Response:**
```json
{
  "status": "healthy",
  "version": "2.0.0-alpha.21",
  "uptime": 3600,
  "timestamp": "2026-01-27T12:00:00.000Z",
  "services": { ... },
  "bridgeDetails": [
    {
      "id": "abc123",
      "name": "My Bridge",
      "status": "running",
      "port": 5540,
      "deviceCount": 15,
      "fabricCount": 2,
      "fabrics": [
        {
          "fabricIndex": 1,
          "label": "Apple Home",
          "rootVendorId": 4937
        }
      ],
      "failedEntityCount": 0
    }
  ],
  "recovery": {
    "enabled": true,
    "lastRecoveryAttempt": "2026-01-27T11:00:00.000Z",
    "recoveryCount": 1
  }
}
```

#### GET /health/live
Kubernetes liveness probe endpoint.

**Response:** `200 OK`

#### GET /health/ready
Kubernetes readiness probe endpoint.

**Response:**
- `200 OK` - Home Assistant connected
- `503 Not Ready` - Home Assistant not connected

---

### Matter/Bridge API

Base path: `/api/matter`

#### GET /matter/bridges
List all configured bridges.

**Response:**
```json
[
  {
    "id": "abc123",
    "name": "My Bridge",
    "port": 5540,
    "status": "running",
    "deviceCount": 15,
    "filter": {
      "include": [...],
      "exclude": [...]
    }
  }
]
```

#### POST /matter/bridges
Create a new bridge.

**Request Body:**
```json
{
  "name": "New Bridge",
  "port": 5541,
  "filter": {
    "include": [
      { "type": "domain", "value": "light" }
    ],
    "exclude": []
  }
}
```

**Response:** `200` with created bridge data

#### GET /matter/bridges/:bridgeId
Get a specific bridge by ID.

**Response:** `200` with bridge data or `404 Not Found`

#### PUT /matter/bridges/:bridgeId
Update an existing bridge.

**Request Body:**
```json
{
  "id": "abc123",
  "name": "Updated Bridge",
  "port": 5540,
  "filter": { ... }
}
```

**Response:** `200` with updated bridge data

#### DELETE /matter/bridges/:bridgeId
Delete a bridge.

**Response:** `204 No Content`

#### POST /matter/bridges/:bridgeId/actions/start
Start a stopped bridge.

**Response:** `200` with bridge data

#### POST /matter/bridges/:bridgeId/actions/stop
Stop a running bridge.

**Response:** `200` with bridge data

#### POST /matter/bridges/:bridgeId/actions/restart
Restart a bridge (stop + start).

**Response:** `200` with bridge data

#### POST /matter/bridges/:bridgeId/actions/refresh
Refresh devices on a bridge without restarting.

**Response:** `200` with bridge data

#### POST /matter/bridges/:bridgeId/actions/factory-reset
Factory reset a bridge (removes all fabrics/pairings).

**Response:** `200` with bridge data

#### GET /matter/bridges/:bridgeId/devices
Get all Matter devices exposed by a bridge.

**Response:**
```json
{
  "endpoint": 0,
  "type": "Aggregator",
  "parts": [
    {
      "endpoint": 1,
      "type": "OnOffLight",
      "entity_id": "light.living_room"
    }
  ]
}
```

#### GET /matter/next-port
Get the next available port for a new bridge.

**Response:**
```json
{
  "port": 5542
}
```

#### POST /matter/filter-preview
Preview which entities would be matched by a filter.

**Request Body:**
```json
{
  "include": [
    { "type": "domain", "value": "light" }
  ],
  "exclude": [
    { "type": "pattern", "value": "*test*" }
  ]
}
```

**Response:**
```json
{
  "total": 25,
  "entities": [
    {
      "entity_id": "light.living_room",
      "friendly_name": "Living Room Light",
      "domain": "light"
    }
  ],
  "truncated": false
}
```

---

### Home Assistant API

Base path: `/api/home-assistant`

#### GET /home-assistant/stats
Get statistics about Home Assistant entities and devices.

**Response:**
```json
{
  "entities": {
    "total": 150,
    "byDomain": {
      "light": 25,
      "switch": 30,
      "sensor": 50,
      "binary_sensor": 45
    }
  },
  "devices": {
    "total": 40
  },
  "connection": {
    "connected": true,
    "url": "[redacted]"
  }
}
```

#### GET /home-assistant/entities
List Home Assistant entities with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `domain` | string | - | Filter by domain (e.g., "light") |
| `search` | string | - | Search in entity_id and friendly_name |
| `limit` | number | 100 | Max results (1-500) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "total": 150,
  "limit": 100,
  "offset": 0,
  "entities": [
    {
      "entity_id": "light.living_room",
      "friendly_name": "Living Room Light",
      "domain": "light",
      "device_id": "device123",
      "device_name": "Hue Bulb",
      "state": "on",
      "attributes": {
        "brightness": 255,
        "color_mode": "rgb"
      },
      "last_changed": "2026-01-27T12:00:00.000Z",
      "last_updated": "2026-01-27T12:00:00.000Z"
    }
  ]
}
```

#### GET /home-assistant/entities/:entityId
Get detailed information about a specific entity.

**Response:** `200` with entity data or `404 Not Found`

#### GET /home-assistant/devices
List Home Assistant devices with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `search` | string | - | Search in name, manufacturer, model |
| `limit` | number | 100 | Max results (1-500) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "total": 40,
  "limit": 100,
  "offset": 0,
  "devices": [
    {
      "id": "device123",
      "name": "Hue Bulb",
      "manufacturer": "Philips",
      "model": "LCT001",
      "sw_version": "1.50.2",
      "hw_version": "1.0",
      "area_id": "living_room",
      "entity_count": 3
    }
  ]
}
```

#### GET /home-assistant/devices/:deviceId
Get detailed information about a device including all its entities.

**Response:**
```json
{
  "id": "device123",
  "name": "Hue Bulb",
  "manufacturer": "Philips",
  "model": "LCT001",
  "entity_count": 3,
  "entities": [
    {
      "entity_id": "light.hue_bulb",
      "friendly_name": "Hue Bulb",
      "state": "on",
      ...
    }
  ]
}
```

#### GET /home-assistant/domains
Get a list of all domains with entity counts.

**Response:**
```json
{
  "domains": [
    { "domain": "sensor", "count": 50 },
    { "domain": "binary_sensor", "count": 45 },
    { "domain": "light", "count": 25 }
  ]
}
```

#### POST /home-assistant/refresh
Force refresh of the Home Assistant entity registry.

**Response:**
```json
{
  "success": true,
  "message": "Registry refreshed"
}
```

---

### Entity Mapping API

Base path: `/api/entity-mappings`

#### GET /entity-mappings/:bridgeId
Get all entity mappings for a bridge.

**Response:**
```json
{
  "bridgeId": "abc123",
  "mappings": [
    {
      "entityId": "light.living_room",
      "matterDeviceType": "OnOffLight",
      "customName": "Living Room",
      "disabled": false
    }
  ]
}
```

#### GET /entity-mappings/:bridgeId/:entityId
Get mapping for a specific entity.

**Response:** `200` with mapping data or `404 Not Found`

#### PUT /entity-mappings/:bridgeId/:entityId
Create or update an entity mapping.

**Request Body:**
```json
{
  "matterDeviceType": "DimmableLight",
  "customName": "Custom Name",
  "disabled": false
}
```

**Response:** `200` with updated mapping

#### DELETE /entity-mappings/:bridgeId/:entityId
Delete a specific entity mapping.

**Response:** `204 No Content`

#### DELETE /entity-mappings/:bridgeId
Delete all mappings for a bridge.

**Response:** `204 No Content`

---

### Bridge Export/Import API

Base path: `/api/bridges`

#### GET /bridges/export
Export all bridge configurations as JSON.

**Response:** JSON file download (`hamh-bridges-YYYY-MM-DD.json`)

#### GET /bridges/export/:bridgeId
Export a single bridge configuration.

**Response:** JSON file download

#### POST /bridges/import/preview
Preview an import without applying changes.

**Request Body:** Export JSON data

**Response:**
```json
{
  "version": 1,
  "exportedAt": "2026-01-27T12:00:00.000Z",
  "migrated": false,
  "sourceVersion": "v1",
  "bridges": [
    {
      "id": "abc123",
      "name": "My Bridge",
      "port": 5540,
      "entityCount": 15,
      "exists": true
    }
  ]
}
```

#### POST /bridges/import
Import bridge configurations.

**Request Body:**
```json
{
  "data": { /* export data */ },
  "options": {
    "bridgeIds": ["abc123", "def456"],
    "overwriteExisting": true
  }
}
```

**Response:**
```json
{
  "imported": 2,
  "skipped": 0,
  "errors": []
}
```

---

### Backup API

Base path: `/api/backup`

#### GET /backup/download
Download a full backup (ZIP archive) containing bridges and entity mappings.

**Response:** ZIP file download (`hamh-backup-YYYY-MM-DD.zip`)

#### POST /backup/restore/preview
Preview a backup restore.

**Request:** Multipart form with `file` field (ZIP)

**Response:**
```json
{
  "version": 1,
  "createdAt": "2026-01-27T12:00:00.000Z",
  "bridges": [
    {
      "id": "abc123",
      "name": "My Bridge",
      "port": 5540,
      "exists": false,
      "hasMappings": true,
      "mappingCount": 5
    }
  ]
}
```

#### POST /backup/restore
Restore from a backup.

**Request:** Multipart form with:
- `file`: ZIP backup file
- `options`: JSON string with restore options

**Options:**
```json
{
  "bridgeIds": ["abc123"],
  "overwriteExisting": true,
  "includeMappings": true
}
```

**Response:**
```json
{
  "bridgesRestored": 1,
  "bridgesSkipped": 0,
  "mappingsRestored": 5,
  "errors": []
}
```

---

### Logs API

Base path: `/api/logs`

#### GET /logs
Get application logs with filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | string | - | Filter by level(s), comma-separated (e.g., "error,warn") |
| `search` | string | - | Search in log messages |
| `limit` | number | 100 | Max results (1-500) |
| `offset` | number | 0 | Pagination offset |

**Response:**
```json
{
  "total": 500,
  "limit": 100,
  "offset": 0,
  "entries": [
    {
      "timestamp": "2026-01-27T12:00:00.000Z",
      "level": "info",
      "message": "Bridge started successfully",
      "context": {
        "bridgeId": "abc123"
      }
    }
  ]
}
```

#### GET /logs/levels
Get count of logs by level.

**Response:**
```json
{
  "levels": {
    "info": 400,
    "warn": 50,
    "error": 10,
    "debug": 40
  }
}
```

#### DELETE /logs
Clear all stored logs.

**Response:**
```json
{
  "success": true,
  "message": "Logs cleared"
}
```

#### GET /logs/stream
Server-Sent Events (SSE) stream of real-time logs.

**Response:** `text/event-stream`

```
data: {"timestamp":"2026-01-27T12:00:00.000Z","level":"info","message":"..."}

data: {"timestamp":"2026-01-27T12:00:01.000Z","level":"debug","message":"..."}
```

---

### Metrics API

Base path: `/api/metrics`

#### GET /metrics
Get system metrics in JSON format.

**Response:**
```json
{
  "timestamp": "2026-01-27T12:00:00.000Z",
  "uptime": 3600,
  "memory": {
    "heapUsed": 52428800,
    "heapTotal": 104857600,
    "external": 1048576,
    "rss": 157286400
  },
  "bridges": {
    "total": 2,
    "running": 2,
    "stopped": 0,
    "failed": 0,
    "totalDevices": 30,
    "totalFabrics": 4
  },
  "homeAssistant": {
    "connected": true,
    "entities": 150,
    "devices": 40
  }
}
```

#### GET /metrics/prometheus
Get metrics in Prometheus format.

**Response:** `text/plain`

```
# HELP hamh_uptime_seconds Application uptime in seconds
# TYPE hamh_uptime_seconds gauge
hamh_uptime_seconds 3600

# HELP hamh_memory_heap_used_bytes Heap memory used in bytes
# TYPE hamh_memory_heap_used_bytes gauge
hamh_memory_heap_used_bytes 52428800

# HELP hamh_bridges_total Total number of bridges
# TYPE hamh_bridges_total gauge
hamh_bridges_total 2

# HELP hamh_bridges_running Number of running bridges
# TYPE hamh_bridges_running gauge
hamh_bridges_running 2

# HELP hamh_devices_total Total number of Matter devices
# TYPE hamh_devices_total gauge
hamh_devices_total 30

# HELP hamh_fabrics_total Total number of connected fabrics
# TYPE hamh_fabrics_total gauge
hamh_fabrics_total 4

# HELP hamh_ha_connected Home Assistant connection status
# TYPE hamh_ha_connected gauge
hamh_ha_connected 1

# HELP hamh_ha_entities_total Total number of Home Assistant entities
# TYPE hamh_ha_entities_total gauge
hamh_ha_entities_total 150

# HELP hamh_bridge_status Bridge status (1=running, 0=not running)
# TYPE hamh_bridge_status gauge
hamh_bridge_status{bridge_id="abc123",bridge_name="My_Bridge"} 1

# HELP hamh_bridge_devices Number of devices on bridge
# TYPE hamh_bridge_devices gauge
hamh_bridge_devices{bridge_id="abc123",bridge_name="My_Bridge"} 15
```

---

### WebSocket API

**Endpoint:** `ws://<host>:<port>/api/ws`

The WebSocket API provides real-time updates for bridge status changes.

#### Message Types

**Incoming Messages:**

| Type | Description |
|------|-------------|
| `ping` | Client ping, server responds with `pong` |

**Outgoing Messages:**

| Type | Description |
|------|-------------|
| `bridges_update` | All bridges have been updated |
| `bridge_update` | Single bridge has been updated |
| `pong` | Response to client ping |
| `ping` | Server keepalive (every 30s) |

#### Message Format

```json
{
  "type": "bridge_update",
  "bridgeId": "abc123",
  "data": {
    "id": "abc123",
    "name": "My Bridge",
    "status": "running",
    ...
  }
}
```

#### Connection Example

```javascript
const ws = new WebSocket('ws://localhost:8482/api/ws');

ws.onopen = () => {
  console.log('Connected');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  switch (message.type) {
    case 'bridges_update':
      console.log('All bridges:', message.data);
      break;
    case 'bridge_update':
      console.log(`Bridge ${message.bridgeId} updated:`, message.data);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
};
```

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "error": "Error message description"
}
```

Common HTTP status codes:
- `400` - Bad Request (invalid input)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable

---

## Rate Limiting

Currently, the API does not implement rate limiting. This may change in future versions.

---

## Changelog

### v2.0.0-alpha.22 (Upcoming)
- Added Home Assistant Entities API (`/api/home-assistant`)
- Added Logs API (`/api/logs`)
- Added Metrics API with Prometheus support (`/api/metrics`)
- Added bridge start/stop/refresh actions
- Changed factory-reset from GET to POST (breaking change)

### v2.0.0-alpha.1
- Initial API implementation
- Health API
- Matter/Bridge API
- Entity Mapping API
- Bridge Export/Import API
- Backup API
- WebSocket API
