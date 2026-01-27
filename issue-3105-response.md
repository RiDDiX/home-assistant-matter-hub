## Enhanced Debug Logs with Stack Trace

Here are the logs with `JSON.stringify(location)` and `new Error()` as requested:

```
2026-01-27 21:02:52.304 WARN   FabricAccessControl  Access control check without cluster, returning View access level 
{"path":{"parent":{"parent":{"parent":{"parent":{"id":"80c129023c064fb3bccd688a0e0f2bc5","type":"RootNode"},"id":"aggregator","type":"Aggregator"},"id":"Test_Fan1","type":"Fan"},"id":"homeAssistantEntity"},"id":"state"},"endpoint":186} (unknown error)
  at FabricAccessControl.accessLevelsFor (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:87678:117)
  at Object.authorityAt (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:110576:44)
  at Object.mayRead (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:93252:20)
  at descriptor.get [as entity] (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:107451:18)
  at get entity (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:136496:23)
  at get isAvailable (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:136502:17)
  at FanControlServerBase.targetPercentSettingChanged (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:149409:24)
  at #reactWithContext (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:125477:12)
  at #react (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:125406:44)
  at reactorListener (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:125314:35)
  at EventProxy.emit (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:4750:22)
  at OnlineEvent.emit (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:4750:22)
  at emitChanged (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:120299:31)
  at Object.postCommit (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:120309:12)
  at executePostCommit (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:13174:55)
  at async AttributeWriteResponse.writeValue (file:///usr/local/lib/node_modules/home-assistant-matter-hub/dist/backend/cli.js:94338:9)
```

## Analysis

The `location` object reveals the issue:

```json
{
  "path": {
    "id": "state",
    "parent": {
      "id": "homeAssistantEntity",
      "parent": {
        "id": "Test_Fan1",
        "type": "Fan",
        "parent": {
          "id": "aggregator", 
          "type": "Aggregator",
          "parent": {
            "id": "80c129023c064fb3bccd688a0e0f2bc5",
            "type": "RootNode"
          }
        }
      }
    }
  },
  "endpoint": 186
}
```

**Key finding:** The access control check is being triggered for `homeAssistantEntity.state` - this is a **custom behavior** we added to store Home Assistant entity state, NOT a Matter cluster.

### Call flow:
1. Controller sends `WriteRequest` for `FanControl.percentSetting`
2. `AttributeWriteResponse.writeValue` processes the write
3. After commit, `emitChanged` fires the `$Changed` event
4. Our `FanControlServerBase.targetPercentSettingChanged` handler is called via `reactTo`
5. Handler accesses `this.isAvailable` getter
6. `isAvailable` getter accesses `this.entity` 
7. `this.entity` triggers `mayRead` access check on the `homeAssistantEntity` behavior's `state`
8. `FabricAccessControl.accessLevelsFor` is called with `location.cluster === undefined` because `homeAssistantEntity` is not a cluster behavior

### Our code pattern:
```typescript
// In our FanControlServer behavior:
get entity() {
  return this.agent.get(HomeAssistantEntityBehavior).entity;
}

get isAvailable() {
  return this.entity?.state === "on" || this.entity?.state === "off";
}

targetPercentSettingChanged(value: number) {
  if (!this.isAvailable) return;  // <-- This triggers the access check
  // ... call Home Assistant
}
```

The `HomeAssistantEntityBehavior` is a custom `Behavior.MutableState` we use to share HA entity state across behaviors on the same endpoint. It seems Matter.js is applying access control checks when accessing state on ANY behavior, not just cluster behaviors.

Is this expected behavior? Should we be accessing our custom behavior state differently to avoid triggering access control?
