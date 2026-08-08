import { describe, expect, it } from "vitest";
import {
  summarizeSubscription,
  summarizeSubscriptions,
} from "./subscription-summary.js";

// Pure table tests for the subscription scope helper. Plain objects stand in
// for matter.js ServerSubscription, exercising the duck-typed reads.

describe("summarizeSubscription", () => {
  it("flags wildcard when an attribute path omits the endpointId", () => {
    const summary = summarizeSubscription({
      subscriptionId: 5,
      request: {
        attributeRequests: [{ clusterId: 6 }, { endpointId: 2 }],
      },
    });
    expect(summary).toEqual({
      id: 5,
      attributePaths: 2,
      eventPaths: 0,
      scope: "wildcard",
      endpointIds: [2],
    });
  });

  it("flags wildcard when an event path omits the endpointId", () => {
    const summary = summarizeSubscription({
      subscriptionId: 6,
      request: {
        eventRequests: [{ clusterId: 8 }],
      },
    });
    expect(summary.scope).toBe("wildcard");
    expect(summary.eventPaths).toBe(1);
  });

  it("stays wildcard when concrete attribute paths meet a wildcard event path", () => {
    const summary = summarizeSubscription({
      subscriptionId: 6,
      request: {
        attributeRequests: [{ endpointId: 3, clusterId: 6 }],
        eventRequests: [{ clusterId: 8 }],
      },
    });
    expect(summary.scope).toBe("wildcard");
    expect(summary.endpointIds).toEqual([3]);
  });

  it("normalizes a bigint endpoint id", () => {
    const summary = summarizeSubscription({
      subscriptionId: 6,
      request: {
        attributeRequests: [{ endpointId: 4n, clusterId: 6 }],
      },
    });
    expect(summary.scope).toBe("endpoint-specific");
    expect(summary.endpointIds).toEqual([4]);
  });

  it("is endpoint-specific with a deduped, sorted endpoint list", () => {
    const summary = summarizeSubscription({
      subscriptionId: 7,
      request: {
        attributeRequests: [{ endpointId: 7 }, { endpointId: 3 }],
        eventRequests: [{ endpointId: 3 }],
      },
    });
    expect(summary).toEqual({
      id: 7,
      attributePaths: 2,
      eventPaths: 1,
      scope: "endpoint-specific",
      endpointIds: [3, 7],
    });
  });

  it("classifies an unreadable request as unknown", () => {
    const summary = summarizeSubscription({ subscriptionId: 9 });
    expect(summary).toEqual({
      id: 9,
      attributePaths: 0,
      eventPaths: 0,
      scope: "unknown",
      endpointIds: [],
    });
  });

  it("classifies a request without path arrays as unknown", () => {
    const summary = summarizeSubscription({
      subscriptionId: 10,
      request: { somethingElse: true },
    });
    expect(summary.scope).toBe("unknown");
  });

  it("yields a null id when the subscriptionId is missing", () => {
    const summary = summarizeSubscription({
      request: { attributeRequests: [{ endpointId: 1 }] },
    });
    expect(summary.id).toBeNull();
    expect(summary.scope).toBe("endpoint-specific");
  });
});

describe("summarizeSubscriptions", () => {
  it("returns an empty list for an empty set", () => {
    expect(summarizeSubscriptions([])).toEqual([]);
  });

  it("returns an empty list when the value is not iterable", () => {
    expect(
      summarizeSubscriptions({ size: 3 } as unknown as Iterable<unknown>),
    ).toEqual([]);
  });

  it("summarizes every subscription in order", () => {
    const result = summarizeSubscriptions([
      {
        subscriptionId: 1,
        request: { attributeRequests: [{ endpointId: 4 }] },
      },
      { subscriptionId: 2, request: { attributeRequests: [{ clusterId: 6 }] } },
    ]);
    expect(result.map((s) => s.scope)).toEqual([
      "endpoint-specific",
      "wildcard",
    ]);
    expect(result.map((s) => s.id)).toEqual([1, 2]);
  });
});
