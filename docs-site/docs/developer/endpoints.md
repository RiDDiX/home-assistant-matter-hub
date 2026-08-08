# Endpoint Management in Bridges

Each bridge exposes child endpoints that represent Home Assistant entities. This page walks through how those endpoints are built, updated, and torn down.

## The mapping pipeline

The legacy endpoint factory lives in `packages/backend/src/matter/endpoints/legacy/`. It maps one HA entity to one Matter endpoint by way of a per-domain dispatcher:

```
HA entity
  → createLegacyEndpointType()        (entry point)
    → dispatches on HomeAssistantDomain
      → legacy/<domain>/index.ts      (per-domain builder)
        → Matter device type + behavior servers
          → .set({ homeAssistantEntity })
```

`createLegacyEndpointType()` reads the entity's `domain`, looks up the domain's builder function, and returns the composed endpoint type. The builder decides which Matter device type fits (e.g. `OnOffLight` vs `DimmableLight` based on HA's `supported_color_modes`), then uses matter.js's `.with(...)` to compose behavior servers onto the device type.

Behavior servers wrap matter.js cluster servers and pull values from the HA entity via `HomeAssistantEntityBehavior`, the shared behavior every legacy endpoint carries. Each behavior server follows the same pattern:

```ts
class MyServer extends Base {
  override async initialize() {
    await super.initialize();
    const ha = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(ha.entity);
    this.reactTo(ha.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    // read entity.state / entity.state.attributes
    // write to this.state via applyPatchState()
  }
}
```

`applyPatchState` is the project's wrapper around matter.js state writes. It only writes fields that actually changed, and it swallows a small set of matter.js lifecycle errors (`DestroyedDependencyError`, transaction conflicts) that fire during shutdown.

## BridgeEndpointManager

`packages/backend/src/services/bridges/bridge-endpoint-manager.ts` owns the root aggregator endpoint and the set of child endpoints that hang off it.

Responsibilities:

- **Build endpoints** from the filtered entity list (`BridgeRegistry.includedEntities`) and plug devices.
- **Refresh** when the HA registry changes, create missing endpoints, delete removed ones, rewire mapped companion sensors.
- **Forward state updates** from HA (via `subscribeEntities`) into matter.js via each endpoint's `updateStates()`.
- **Serialize state bursts** so that when HA fires 200 state updates in 50 ms (restart, scene activation), matter.js only sees one batch at a time, the manager keeps a pending batch and collapses consecutive calls.
- **Track plugin endpoints** separately: listeners on plugin cluster events are kept so they can be detached when the plugin removes a device.

Typical call site in `start-handler.ts`:

```ts
const manager = new BridgeEndpointManager(client, registry, mappingStorage, bridgeId, log);
manager.startObserving();
```

## HomeAssistantRegistry.enableAutoRefresh

`HomeAssistantRegistry` polls HA's entity / device / label / area registries on a timer (default 60 s). `enableAutoRefresh(callback)` wires up the interval; the callback runs only when the registry fingerprint actually changed.

```ts
enableAutoRefresh = initBridges
  .then(() => registry$)
  .then((r) => r.enableAutoRefresh(() => bridgeService.refreshAll()));
```

The callback is guarded against overlapping runs, if the previous tick is still retrying (slow HA, reconnect), the next tick skips instead of stacking up.

## Endpoint update flow

1. HA entity state changes.
2. `subscribeEntities` fires a batch delivery.
3. `BridgeEndpointManager.updateStates(states)` gets called.
4. If no update is in flight, it runs `runUpdateStates` immediately. If one is running, it stashes the newest batch and lets the running call pick it up when done.
5. `runUpdateStates` merges the batch into the registry and dispatches `endpoint.updateStates(states)` to every child endpoint in parallel.
6. Each `LegacyEndpoint.updateStates` compares the entity against its last cached state, state string plus a deep-equal attribute check, and returns early if nothing changed, so the matter.js cluster writes don't fire when they don't need to.

## Full registry-refresh flow

1. Interval fires on `HomeAssistantRegistry.enableAutoRefresh`.
2. `reload()` retries `fetchRegistries()` up to 10 times against WS timeouts.
3. All five HA calls (`config/entity_registry/list`, `getStates`, `config/device_registry/list`, `config/label_registry/list`, `config/area_registry/list`) fire in parallel with a 30 s timeout each via `sendHaMessage`.
4. The registry computes an MD5 fingerprint over structural entity/device/state metadata. Unchanged → skip.
5. Changed → rebuild the registry, invoke the `onRefresh` callback, which reaches `BridgeService.refreshAll()` → each bridge's `refreshDevices()`.

## Where to start when adding a new domain

1. Create `packages/backend/src/matter/endpoints/legacy/<domain>/index.ts` with a builder function that returns an `EndpointType`.
2. Pick the matter.js device type (`@matter/main/devices`) and the behavior servers (`@matter/main/behaviors` plus any HAMH-local ones in `packages/backend/src/matter/behaviors/`).
3. If the domain maps onto a new cluster, add an enum entry to `packages/common/src/clusters/index.ts`, the cluster-validation test in `create-legacy-endpoint-type.test.ts` asserts every cluster ID a HAMH endpoint exposes is in that enum.
4. Wire the domain into `createLegacyEndpointType()`.
5. Add controller-compatibility rows to `docs-site/docs/guides/controller-compatibility.md`. Every cell starts as `❓` until a vendor doc or pair-test proves otherwise.
