import { describe, expect, it } from "vitest";
import { categoryFor, MATTER_TRAFFIC_FACILITIES } from "./logger.js";

describe("categoryFor", () => {
  it("tags traffic facilities as matter-traffic", () => {
    for (const facility of MATTER_TRAFFIC_FACILITIES) {
      expect(categoryFor(facility)).toBe("matter-traffic");
    }
  });

  it("returns undefined for HAMH-internal facilities", () => {
    expect(categoryFor("EntityEndpoint")).toBeUndefined();
    expect(categoryFor("BridgeEndpointManager")).toBeUndefined();
    expect(categoryFor("WebApi / Access Log")).toBeUndefined();
  });

  it("returns undefined for unknown matter.js facilities", () => {
    expect(categoryFor("BTP")).toBeUndefined();
    expect(categoryFor("Crypto")).toBeUndefined();
    expect(categoryFor("NetworkInterface")).toBeUndefined();
  });

  it("is case-sensitive (matter.js facility names are stable)", () => {
    expect(categoryFor("interactionserver")).toBeUndefined();
    expect(categoryFor("InteractionServer")).toBe("matter-traffic");
  });
});

describe("MATTER_TRAFFIC_FACILITIES", () => {
  it("covers the documented controller-traffic facilities", () => {
    expect(MATTER_TRAFFIC_FACILITIES.has("InteractionServer")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("MessageExchange")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("MessageChannel")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("ServerSubscription")).toBe(true);
  });

  it("surfaces rejected invokes in the traffic category (#423)", () => {
    // UnsupportedEndpoint rejections log under this facility; dropping it
    // hides a controller aiming at a stale endpoint number.
    expect(categoryFor("CommandInvokeResponse")).toBe("matter-traffic");
  });
});
