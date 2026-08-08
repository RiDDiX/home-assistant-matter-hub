import { describe, expect, it } from "vitest";
import { ServerModeBridge } from "./server-mode-bridge.js";

// Minimal fakes: getSessionInfo only reads server.env.get(SessionManager)
// and this.sessionStartedAt, so the rest can stay empty.
function makeBridge(sessions: unknown[]) {
  const logger = {
    get: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };
  const server = { env: { get: () => ({ sessions }) } };
  return new ServerModeBridge(
    logger as never,
    {} as never,
    {} as never,
    server as never,
  );
}

describe("ServerModeBridge.getSessionInfo", () => {
  it("reports fabricIndex per session and a fabric roll-up", () => {
    const bridge = makeBridge([
      {
        id: 1,
        peerNodeId: 10n,
        subscriptions: { size: 3 },
        activeTimestamp: 1,
        timestamp: 1,
        isPeerActive: true,
        fabric: { fabricIndex: 2 },
      },
    ]);

    const info = bridge.getSessionInfo();

    expect(info.sessions[0].fabricIndex).toBe(2);
    expect(info.fabrics).toEqual([
      { fabricIndex: 2, sessions: 1, subscriptions: 3 },
    ]);
  });

  it("leaves PASE sessions unattached (fabricIndex null, no roll-up)", () => {
    const bridge = makeBridge([
      {
        id: 2,
        peerNodeId: 11n,
        subscriptions: { size: 0 },
        activeTimestamp: 0,
        timestamp: 1,
        isPeerActive: false,
        fabric: undefined,
      },
    ]);

    const info = bridge.getSessionInfo();

    expect(info.sessions[0].fabricIndex).toBeNull();
    expect(info.fabrics).toEqual([]);
  });

  it("summarizes each session's subscriptions with scope", () => {
    // Iterable subscriptions that also expose .size, mirroring the matter.js
    // BasicSet the count read already relies on.
    const subscriptions = Object.assign(
      [
        {
          subscriptionId: 7,
          request: {
            attributeRequests: [{ endpointId: 3 }, { endpointId: 7 }],
          },
        },
      ],
      { size: 1 },
    );
    const bridge = makeBridge([
      {
        id: 1,
        peerNodeId: 10n,
        subscriptions,
        activeTimestamp: 1,
        timestamp: 1,
        isPeerActive: true,
        fabric: { fabricIndex: 2 },
      },
    ]);

    const info = bridge.getSessionInfo();

    expect(info.sessions[0].subscriptionCount).toBe(1);
    expect(info.sessions[0].subscriptions).toEqual([
      {
        id: 7,
        attributePaths: 2,
        eventPaths: 0,
        scope: "endpoint-specific",
        endpointIds: [3, 7],
      },
    ]);
  });

  it("marks a whole-node wildcard subscription", () => {
    const subscriptions = Object.assign(
      [
        {
          subscriptionId: 1,
          request: { attributeRequests: [{ clusterId: 6 }] },
        },
      ],
      { size: 1 },
    );
    const bridge = makeBridge([
      {
        id: 1,
        peerNodeId: 10n,
        subscriptions,
        activeTimestamp: 1,
        timestamp: 1,
        isPeerActive: true,
        fabric: { fabricIndex: 2 },
      },
    ]);

    expect(bridge.getSessionInfo().sessions[0].subscriptions[0].scope).toBe(
      "wildcard",
    );
  });
});
