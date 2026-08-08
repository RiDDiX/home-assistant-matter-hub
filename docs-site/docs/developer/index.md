# Developer Documentation

## Overview

Home Assistant Matter Hub (HAMH) is an addon for Home Assistant that acts as a Matter bridge, exposing Home Assistant devices to Matter controllers (Alexa, Apple Home, Google Home) via local communication. No cloud or custom skills are required.

This documentation is intended for developers taking over or contributing to the project. It covers architecture, technologies, and key concepts, especially those related to the Matter protocol and bridging logic.

---

## Documentation Structure

- [Behaviors](./behaviors.md): How behaviors work, configuration, and extension.
- [Service Management](./services.md): AppEnvironment, BridgeEnvironment, and service dependencies.
- [Endpoint Management](./endpoints.md): How bridge endpoints are managed and updated.

---

## Technologies Used

- **TypeScript**: Main language for backend, frontend, and shared logic.
- **Node.js**: Runtime for backend services and CLI.
- **Express**: REST API for bridge management.
- **Vite**: Frontend build tool.
- **React**: Frontend UI framework.
- **@matter/main, @matter/nodejs, @matter/general**: Libraries implementing the Matter protocol and device abstractions.
- **home-assistant-js-websocket**: Integration with Home Assistant's API.
- **Ajv**: JSON schema validation for API requests.
- **Docker**: Containerization for deployment.

---

## Architecture

### High-Level Structure

- **Backend** (`packages/backend`): Implements bridge logic, Matter protocol, Home Assistant integration, and exposes REST API.
- **Frontend** (`packages/frontend`): UI for managing bridges and devices.
- **Common** (`packages/common`): Shared types and utilities.
- **Docs** (`packages/docs`): Documentation and guides.

### Key Backend Components

- **BridgeService**: Manages lifecycle of bridges (create, update, delete, start, stop, refresh).
- **Bridge**: Represents a running bridge instance, including Matter server node and aggregator.
- **BridgeFactory**: Abstract factory for creating bridges.
- **BridgeStorage**: Persists bridge configurations and metadata.
- **BridgeEndpointManager**: Manages endpoints/devices exposed by a bridge.
- **HomeAssistantClient**: Handles connection and communication with Home Assistant.
- **HomeAssistantActions**: Invokes Home Assistant services (turn on/off, etc).

---

## Matter Concepts & Library Usage

### Matter Bridge

A bridge is a Matter node that exposes multiple endpoints (devices) to controllers. In HAMH, each bridge is backed by a Matter server node and an aggregator endpoint.

- **BridgeServerNode**: Subclass of `ServerNode` from `@matter/main/node`. Configured with bridge metadata and endpoints.
- **AggregatorEndpoint**: Root endpoint that groups all exposed devices.
- **Endpoints**: Each Home Assistant entity is mapped to a Matter endpoint (e.g., light, switch, sensor).

See [Endpoint Management](./endpoints.md) for details on how endpoints are created, updated, and synchronized.

### Endpoints & Behaviors

Endpoints are created using device types from `@matter/main/devices` and composed with behaviors:

- **BasicInformationServer**: Provides device metadata.
- **IdentifyServer**: Implements Matter identify cluster.
- **HomeAssistantEntityBehavior**: Maps Home Assistant entity state/actions to Matter clusters.
- **OnOffServer, LightLevelControlServer, etc.**: Implements specific device clusters (on/off, dimming, color, etc).

Example (Dimmable Light):
```ts
export const DimmableLightType = Device.with(
  IdentifyServer,
  BasicInformationServer,
  HomeAssistantEntityBehavior,
  LightOnOffServer,
  LightLevelControlServer,
);
```

See [Behaviors](./behaviors.md) for a deep dive into how behaviors work and are configured.

### Server Node Configuration

Bridge server nodes are configured using `createBridgeServerConfig`, which sets up:
- Node type and ID
- Network port
- Product/device metadata
- Aggregator endpoint

### Bridge Lifecycle

- **Create**: BridgeService creates a new Bridge via BridgeFactory, persists config in BridgeStorage.
- **Start/Stop**: Bridge manages its Matter server node and endpoints.
- **Refresh**: BridgeEndpointManager updates device states from Home Assistant.
- **Factory Reset**: BridgeServerNode can be reset and erased.

---

## Home Assistant Integration

- **HomeAssistantClient**: Connects to Home Assistant via websocket, maintains connection.
- **HomeAssistantActions**: Calls Home Assistant services (e.g., `light.turn_on`).
- **Entity Mapping**: Each Home Assistant entity is mapped to a Matter endpoint with appropriate behaviors.
- **State Sync**: BridgeEndpointManager subscribes to entity state changes and updates endpoints.

---

## REST API

The backend exposes a REST API via Express for bridge management, entity mappings, diagnostics, backups, and more. For the full list of endpoints, request/response formats, and WebSocket message types, see the [API Reference](../guides/api-reference.md).

---

## Upgrading matter.js

The `@matter/*` packages are pinned to a specific version in `packages/backend/package.json`. Upgrading requires careful validation because matter.js does not guarantee semver stability for internal APIs used by HAMH (SessionManager, CaseServer, DeviceAdvertiser).

### Upgrade Checklist

1. Review the matter.js changelog and migration guide for the target version.
2. Search for breaking changes in APIs used by HAMH:
   - `SessionManager` (session lifecycle, `subscriptionsChanged`, `sessions.added/deleted`)
   - `MutableEndpoint.with()` (behavior composition)
   - `ServerNode` / `CommissioningServer` (bridge lifecycle)
   - `MdnsService` / `DeviceAdvertiser` (mDNS advertisement)
   - Device type definitions in `@matter/main/devices`
3. Update all three packages together: `@matter/general`, `@matter/main`, `@matter/nodejs`.
4. Run the full validation sequence:
   ```bash
   pnpm run lint
   pnpm run build
   pnpm run test
   ```
5. Test pairing with at least one controller (Apple Home, Google Home, or Alexa).
6. Test composed devices (temperature + humidity + pressure sensor grouping).
7. Test server mode (vacuum endpoint).
8. Test forceSync behavior (enable `autoForceSync`, verify changed states are pushed).
9. Test session cleanup (verify stale sessions are closed when a new CASE session opens for the same peer).
10. Build Docker image and verify it starts correctly:
    ```bash
    docker build -f apps/home-assistant-matter-hub/Dockerfile -t hamh-test .
    ```

### Known Internal API Dependencies

| HAMH File | matter.js API | Purpose |
|---|---|---|
| `bridge.ts` | `SessionManager.sessions`, `.subscriptionsChanged` | Session diagnostics and stale session cleanup |
| `bridge.ts` | `DeviceAdvertiser.restartAdvertisement()` | mDNS re-announce after session cleanup |
| `bridge.ts` | `CommissioningServer.enterCommissionableMode()` | Multi-admin commissioning window |
| `create-legacy-endpoint-type.ts` | `MutableEndpoint.with()` | Behavior composition for all device types |
| `bridge-server-node.ts` | `ServerNode` subclass | Bridge server lifecycle |
| `mdns.ts` | `MdnsService` | mDNS configuration |

---

## Development & Handover Notes

- **Start with backend**: Understand BridgeService, Bridge, BridgeEndpointManager, and HomeAssistantClient.
- **Matter concepts**: Familiarize yourself with Matter node, endpoint, aggregator, and cluster abstractions in `@matter` libraries.
- **Entity mapping**: Review how Home Assistant entities are mapped to endpoints and behaviors.
- **Frontend**: UI is in React, communicates with backend via REST API.
- **Docker**: Use provided Dockerfiles for deployment/testing.
- **Testing**: Use provided scripts and test files for backend logic.

---

## Further Reading

- [Matter Protocol Specification](https://csa-iot.org/all-solutions/matter/)
- [Home Assistant Developer Docs](https://developers.home-assistant.io/)
- [HAMH User Documentation](https://riddix.github.io/home-assistant-matter-hub)

---

## Contact & Maintainer

This project is maintained by [riddix](https://github.com/riddix). For questions or contributions, please open an issue or discussion on GitHub.
