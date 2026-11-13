import type { BridgeData } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { BridgeDataProvider } from "./bridge-data-provider.js";

const stored = {
  id: "b1",
  name: "Bridge",
  port: 5540,
  filter: { include: [], exclude: [] },
  featureFlags: { autoForceSync: true },
  countryCode: "DE",
  icon: "light",
  priority: 10,
  serialNumberSuffix: "x1",
  uniqueIdSuffix: "u1",
  sessionMaxAgeHours: 6,
  basicInformation: {},
} as unknown as BridgeData;

describe("BridgeDataProvider.update", () => {
  // The edit form drops a cleared field from the request, so the stored
  // value must not survive the save.
  it("clears optional keys the request leaves out", () => {
    const provider = new BridgeDataProvider(stored);
    provider.update({
      id: "b1",
      name: "Renamed",
      port: 5541,
      filter: { include: [], exclude: [] },
    });

    expect(provider.name).toBe("Renamed");
    expect(provider.port).toBe(5541);
    expect(provider.countryCode).toBeUndefined();
    expect(provider.icon).toBeUndefined();
    expect(provider.priority).toBeUndefined();
    expect(provider.serialNumberSuffix).toBeUndefined();
    expect(provider.uniqueIdSuffix).toBeUndefined();
    expect(provider.sessionMaxAgeHours).toBeUndefined();
    expect(provider.featureFlags).toEqual({ autoForceSync: true });
  });

  it("keeps optional keys the request sends", () => {
    const provider = new BridgeDataProvider(stored);
    provider.update({
      id: "b1",
      name: "Bridge",
      port: 5540,
      filter: { include: [], exclude: [] },
      icon: "fan",
      uniqueIdSuffix: "u2",
    });

    expect(provider.icon).toBe("fan");
    expect(provider.uniqueIdSuffix).toBe("u2");
    expect(provider.countryCode).toBeUndefined();
  });
});
