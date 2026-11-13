import { describe, expect, it } from "vitest";
import type { BridgeService } from "../bridges/bridge-service.js";
import { DiagnosticService } from "./diagnostic-service.js";

const part = {
  state: {
    homeAssistantEntity: {
      entity: { entity_id: "lock.front", state: { state: "locked" } },
    },
    doorLock: {},
  },
};

describe("DiagnosticService", () => {
  it("lists the entities of a server mode bridge", () => {
    const bridgeService = {
      bridges: [
        {
          data: { id: "b1", name: "Lock", status: "running", deviceCount: 1 },
          server: { parts: [part] },
        },
      ],
    } as unknown as BridgeService;
    const [bridge] = new DiagnosticService(bridgeService).getSnapshot().bridges;
    expect(bridge.entities.map((e) => e.entityId)).toEqual(["lock.front"]);
    expect(bridge.entities[0].matterClusters).toEqual(["doorLock"]);
  });
});
