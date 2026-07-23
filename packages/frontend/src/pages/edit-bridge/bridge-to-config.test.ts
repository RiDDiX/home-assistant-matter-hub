import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import { BridgeStatus } from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { bridgeToConfig } from "./bridge-to-config.ts";

const baseBridge: BridgeDataWithMetadata = {
  id: "bridge-1",
  name: "Living Room",
  port: 5540,
  filter: { include: [], exclude: [] },
  serialNumberSuffix: "abc",
  uniqueIdSuffix: "xyz",
  basicInformation: {
    vendorId: 1,
    vendorName: "Test",
    productId: 1,
    productName: "Test",
    productLabel: "Test",
    hardwareVersion: 1,
    softwareVersion: 1,
  },
  status: BridgeStatus.Running,
  deviceCount: 0,
};

describe("bridgeToConfig", () => {
  it("carries sessionMaxAgeHours over when set", () => {
    const config = bridgeToConfig({ ...baseBridge, sessionMaxAgeHours: 4 });
    expect(config.sessionMaxAgeHours).toBe(4);
  });

  it("omits sessionMaxAgeHours entirely when unset", () => {
    const config = bridgeToConfig(baseBridge);
    expect("sessionMaxAgeHours" in config).toBe(false);
  });

  it("keeps the other fields intact on a round trip", () => {
    const config = bridgeToConfig({ ...baseBridge, sessionMaxAgeHours: 4 });
    expect(config.name).toBe("Living Room");
    expect(config.port).toBe(5540);
    expect(config.serialNumberSuffix).toBe("abc");
    expect(config.uniqueIdSuffix).toBe("xyz");
  });
});
