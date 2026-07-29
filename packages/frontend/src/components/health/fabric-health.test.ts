import { describe, expect, it } from "vitest";
import {
  describeSubscriptionScope,
  summarizeFabricHealth,
} from "./fabric-health.ts";

const GOOGLE = 24582;
const APPLE = 4937;

describe("summarizeFabricHealth", () => {
  it("tags the ecosystem and flags a stale fabric", () => {
    const [google] = summarizeFabricHealth(
      [{ fabricIndex: 1, rootVendorId: GOOGLE, label: "Home" }],
      [{ fabricIndex: 1, subscriptionCount: 6, lastActiveMsAgo: 200_000 }],
    );
    expect(google.ecosystem).toBe("google");
    expect(google.connected).toBe(true);
    expect(google.subscriptions).toBe(6);
    expect(google.stale).toBe(true);
  });

  it("does not flag a recently active fabric", () => {
    const [apple] = summarizeFabricHealth(
      [{ fabricIndex: 2, rootVendorId: APPLE, label: "Home" }],
      [{ fabricIndex: 2, subscriptionCount: 4, lastActiveMsAgo: 1_000 }],
    );
    expect(apple.ecosystem).toBe("apple");
    expect(apple.stale).toBe(false);
  });

  it("does not flag a fabric inside one keepalive gap", () => {
    const [apple] = summarizeFabricHealth(
      [{ fabricIndex: 2, rootVendorId: APPLE, label: "Home" }],
      [{ fabricIndex: 2, subscriptionCount: 4, lastActiveMsAgo: 60_000 }],
    );
    expect(apple.stale).toBe(false);
  });

  it("reports a fabric with no sessions as not connected", () => {
    const [fabric] = summarizeFabricHealth(
      [{ fabricIndex: 3, rootVendorId: GOOGLE, label: "Home" }],
      [],
    );
    expect(fabric.connected).toBe(false);
    expect(fabric.stale).toBe(false);
    expect(fabric.subscriptions).toBe(0);
    expect(fabric.subscriptionScope).toBeNull();
  });

  it("rolls a fabric's subscription scopes into a single descriptor", () => {
    const [google] = summarizeFabricHealth(
      [{ fabricIndex: 1, rootVendorId: GOOGLE, label: "Home" }],
      [
        {
          fabricIndex: 1,
          subscriptionCount: 2,
          subscriptions: [
            { scope: "endpoint-specific", endpointIds: [7] },
            { scope: "endpoint-specific", endpointIds: [3, 7] },
          ],
        },
      ],
    );
    expect(google.subscriptionScope).toEqual({
      kind: "endpoint-specific",
      endpointIds: [3, 7],
    });
  });
});

describe("describeSubscriptionScope", () => {
  it("returns null for no summaries", () => {
    expect(describeSubscriptionScope([])).toBeNull();
  });

  it("lets a wildcard win over endpoint-specific", () => {
    expect(
      describeSubscriptionScope([
        { scope: "endpoint-specific", endpointIds: [1] },
        { scope: "wildcard", endpointIds: [] },
      ]),
    ).toEqual({ kind: "wildcard" });
  });

  it("prefers unknown over endpoint-specific when no wildcard", () => {
    expect(
      describeSubscriptionScope([
        { scope: "endpoint-specific", endpointIds: [1] },
        { scope: "unknown", endpointIds: [] },
      ]),
    ).toEqual({ kind: "unknown" });
  });

  it("dedupes and sorts endpoint ids", () => {
    expect(
      describeSubscriptionScope([
        { scope: "endpoint-specific", endpointIds: [9, 2] },
        { scope: "endpoint-specific", endpointIds: [2] },
      ]),
    ).toEqual({ kind: "endpoint-specific", endpointIds: [2, 9] });
  });

  it("returns null for endpoint-specific with no concrete endpoints", () => {
    expect(
      describeSubscriptionScope([
        { scope: "endpoint-specific", endpointIds: [] },
      ]),
    ).toBeNull();
  });
});
