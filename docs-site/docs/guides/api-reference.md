# API Reference

All endpoints return JSON unless otherwise noted. Default port: `8482`.

## Base URL

When using Home Assistant Ingress, endpoints are relative to the ingress URL:
```
/api/hassio_ingress/<ingress_token>/api/...
```

For standalone Docker deployments:
```
http://localhost:8482/api/...
```

## Authentication

If configured, the API uses HTTP Basic Authentication. Set credentials via the Settings page or environment variables.

---

## Health API

Base path: `/api/health`

### GET /api/health

Returns basic health status.

**Response:**
```json
{
  "status": "healthy",
  "version": "2.1.0-alpha.1",
  "uptime": 3600,
  "timestamp": "2026-01-27T12:00:00.000Z",
  "services": {
    "homeAssistant": { "connected": true },
    "bridges": { "total": 2, "running": 2, "stopped": 0, "failed": 0 }
  }
}
```

**Status codes:** `200` healthy/degraded, `503` unhealthy.

### GET /api/health/detailed

Returns detailed health including per-bridge info, fabric details, failed-entity diagnostics, and recovery status with recent attempts.

### GET /api/health/live

Kubernetes liveness probe. Returns `200 OK`.

### GET /api/health/ready

Kubernetes readiness probe. Returns `200` if Home Assistant is connected, `503` otherwise.

---

## Settings API

Base path: `/api/settings`

### GET /api/settings/recovery

Returns the auto-recovery settings: `autoRecoveryEnabled` (boolean) and `recoveryIntervalMs` (number).

### PUT /api/settings/recovery

Updates the auto-recovery settings. Body accepts `autoRecoveryEnabled` and `recoveryIntervalMs` (10000-3600000 ms). Applied live and persisted across restarts.

---

## Matter / Bridge API

Base path: `/api/matter`

### GET /api/matter/bridges

List all configured bridges.

### POST /api/matter/bridges

Create a new bridge.

**Request:**
```json
{
  "name": "New Bridge",
  "port": 5541,
  "filter": {
    "include": [{ "type": "domain", "value": "light" }],
    "exclude": []
  }
}
```

### GET /api/matter/bridges/:bridgeId

Get a specific bridge. Returns `404` if not found.

### PUT /api/matter/bridges/:bridgeId

Update a bridge configuration.

### DELETE /api/matter/bridges/:bridgeId

Delete a bridge. Returns `204 No Content`.

### Bridge Actions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/matter/bridges/:bridgeId/actions/start` | POST | Start a stopped bridge |
| `/api/matter/bridges/:bridgeId/actions/stop` | POST | Stop a running bridge |
| `/api/matter/bridges/:bridgeId/actions/restart` | POST | Restart a bridge |
| `/api/matter/bridges/:bridgeId/actions/refresh` | POST | Refresh devices without restart |
| `/api/matter/bridges/:bridgeId/actions/factory-reset` | POST | Factory reset (removes fabrics) |
| `/api/matter/bridges/:bridgeId/actions/force-sync` | POST | Push current state to controllers |
| `/api/matter/bridges/:bridgeId/actions/open-commissioning-window` | POST | Open pairing window for multi-fabric |
| `/api/matter/bridges/actions/start-all` | POST | Start all bridges |
| `/api/matter/bridges/actions/stop-all` | POST | Stop all bridges |
| `/api/matter/bridges/actions/restart-all` | POST | Restart all bridges |

### PUT /api/matter/bridges/priorities

Update bridge startup priorities.

**Request:**
```json
{ "updates": [{ "id": "abc123", "priority": 1 }] }
```

### POST /api/matter/bridges/:bridgeId/clone

Clone a bridge configuration (new port assigned automatically).

### GET /api/matter/bridges/:bridgeId/devices

Get all Matter devices exposed by a bridge.

### GET /api/matter/next-port

Get the next available port for a new bridge.

### POST /api/matter/filter-preview

Preview which entities match a filter.

### GET /api/matter/labels

Get Home Assistant labels.

### GET /api/matter/areas

Get Home Assistant areas.

### GET /api/matter/filter-values

Get available filter values (domains, labels, areas).

---

## Home Assistant API

Base path: `/api/home-assistant`

### GET /api/home-assistant/stats

Get entity/device statistics and connection status.

### GET /api/home-assistant/entities

List entities with pagination and filtering.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `domain` | string | - | Filter by domain (e.g. `light`) |
| `search` | string | - | Search in entity_id and friendly_name |
| `limit` | number | 100 | Max results (1-500) |
| `offset` | number | 0 | Pagination offset |

### GET /api/home-assistant/entities/:entityId

Get a specific entity. Returns `404` if not found.

### GET /api/home-assistant/devices

List devices with pagination and filtering.

### GET /api/home-assistant/devices/:deviceId

Get a device with all its entities.

### GET /api/home-assistant/domains

Get all domains with entity counts.

### POST /api/home-assistant/refresh

Force refresh the HA entity registry.

### GET /api/home-assistant/related-buttons/:entityId

Get button entities belonging to the same HA device (useful for vacuum room cleaning).

---

## Entity Mapping API

Base path: `/api/entity-mappings`

### GET /api/entity-mappings/:bridgeId

Get all entity mappings for a bridge.

### PUT /api/entity-mappings/:bridgeId/:entityId

Create or update a mapping for a specific entity.

**Request:**
```json
{
  "matterDeviceType": "DimmableLight",
  "customName": "Custom Name",
  "disabled": false
}
```

### DELETE /api/entity-mappings/:bridgeId/:entityId

Delete a specific entity mapping.

### DELETE /api/entity-mappings/:bridgeId

Delete all mappings for a bridge.

---

## Bridge Export / Import API

Base path: `/api/bridges`

### GET /api/bridges/export

Export all bridge configurations as JSON download.

### GET /api/bridges/export/:bridgeId

Export a single bridge.

### POST /api/bridges/import/preview

Preview an import without applying changes.

### POST /api/bridges/import

Import bridge configurations.

**Request:**
```json
{
  "data": { },
  "options": {
    "bridgeIds": ["abc123"],
    "overwriteExisting": true
  }
}
```

---

## Backup API

Base path: `/api/backup`

### GET /api/backup/download

Download a full backup ZIP (bridges + entity mappings).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeIdentity` | boolean | `false` | Include Matter identity files |

### POST /api/backup/restore/preview

Preview a backup restore. Upload as `multipart/form-data` with `file` field.

### POST /api/backup/restore

Restore from a backup. Upload as `multipart/form-data` with `file` and `options` fields.

### POST /api/backup/restart

Restart the application after a restore.

---

## Plugin API

Base path: `/api/plugins`

### GET /api/plugins

List installed plugin packages and active plugins per bridge.

### POST /api/plugins/install

Install a plugin from npm.

**Request:**
```json
{ "packageName": "hamh-plugin-example" }
```

### POST /api/plugins/upload

Install a plugin from an uploaded `.tgz` file. Send the raw binary as the request body with `Content-Type: application/octet-stream`.

### POST /api/plugins/install-local

Link a local plugin directory.

**Request:**
```json
{ "path": "/absolute/path/to/plugin" }
```

### POST /api/plugins/uninstall

Uninstall a plugin package.

**Request:**
```json
{ "packageName": "hamh-plugin-example" }
```

### POST /api/plugins/:bridgeId/:pluginName/enable

Enable a plugin on a bridge.

### POST /api/plugins/:bridgeId/:pluginName/disable

Disable a plugin on a bridge.

### POST /api/plugins/:bridgeId/:pluginName/reset

Reset a plugin's circuit breaker (re-enable after auto-disable from failures).

### GET /api/plugins/:bridgeId/:pluginName/config-schema

Get the JSON config schema for a plugin (if the plugin provides one).

### POST /api/plugins/:bridgeId/:pluginName/config

Update a plugin's configuration.

**Request:**
```json
{ "config": { "pollingInterval": 30000 } }
```

---

## Lock Credentials API

Base path: `/api/lock-credentials`

### GET /api/lock-credentials

Get all lock credentials.

### GET /api/lock-credentials/:entityId

Get credential for a specific lock entity.

### PUT /api/lock-credentials/:entityId

Create or update a lock credential (PIN code).

### PATCH /api/lock-credentials/:entityId/enabled

Enable or disable a lock credential.

### DELETE /api/lock-credentials/:entityId

Delete a lock credential.

---

## Logs API

Base path: `/api/logs`

### GET /api/logs

Retrieve logs with optional filtering.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `level` | string | - | Comma-separated levels (e.g. `error,warn`) |
| `search` | string | - | Search in log messages |
| `limit` | number | 100 | Max entries (1-500) |

### GET /api/logs/levels

Get count of logs by level.

### DELETE /api/logs

Clear all stored logs.

### GET /api/logs/stream

Server-Sent Events (SSE) endpoint for real-time log streaming.

```javascript
const eventSource = new EventSource('api/logs/stream');
eventSource.onmessage = (event) => {
  const log = JSON.parse(event.data);
  console.log(log);
};
```

---

## Metrics API

Base path: `/api/metrics`

### GET /api/metrics

Returns system metrics in **JSON** format (memory, bridges, HA connection status).

### GET /api/metrics/prometheus

Returns metrics in **Prometheus** text format for scraping.

```
# HELP hamh_uptime_seconds Application uptime in seconds
# TYPE hamh_uptime_seconds gauge
hamh_uptime_seconds 3600

# HELP hamh_bridges_total Total number of bridges
# TYPE hamh_bridges_total gauge
hamh_bridges_total 2

# HELP hamh_bridge_status Bridge status (1=running, 0=not running)
# TYPE hamh_bridge_status gauge
hamh_bridge_status{bridge_id="abc123",bridge_name="My_Bridge"} 1
```

---

## System API

Base path: `/api/system`

### GET /api/system/info

Returns system information (hostname, platform, memory, network interfaces, storage).

---

## WebSocket API

**Endpoint:** `ws://<host>:<port>/api/ws`

Real-time updates for bridge status and diagnostics.

### Client → Server Messages

| Type | Description |
|------|-------------|
| `ping` | Client ping; server responds with `pong` |
| `subscribe_diagnostics` | Subscribe to live diagnostic events |
| `unsubscribe_diagnostics` | Unsubscribe from diagnostics |

### Server → Client Messages

| Type | Description |
|------|-------------|
| `bridges_update` | All bridges have been updated (sent on connect + on change) |
| `bridge_update` | Single bridge updated; includes `bridgeId` field |
| `diagnostic_event` | Live diagnostic event (requires subscription) |
| `diagnostic_snapshot` | Initial snapshot sent after subscribing to diagnostics |
| `ping` | Server keepalive (every 30s) |
| `pong` | Response to client ping |

### Example

```javascript
const ws = new WebSocket('ws://localhost:8482/api/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  switch (message.type) {
    case 'bridges_update':
      console.log('All bridges:', message.data);
      break;
    case 'bridge_update':
      console.log(`Bridge ${message.bridgeId}:`, message.data);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
};

// Subscribe to live diagnostics
ws.send(JSON.stringify({ type: 'subscribe_diagnostics' }));
```

---

## Error Responses

All endpoints return errors as:
```json
{ "error": "Error message description" }
```

Common status codes: `400` Bad Request, `404` Not Found, `500` Internal Server Error, `503` Service Unavailable.
