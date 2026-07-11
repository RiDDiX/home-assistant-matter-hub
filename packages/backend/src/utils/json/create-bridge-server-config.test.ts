import { Seconds } from "@matter/general";
import { describe, expect, it } from "vitest";
import { createBridgeServerConfig } from "./create-bridge-server-config.js";

// #386: pin the subscription window with no jitter, else matter.js adds up to
// 10s and our keepalive lands past Google's ceiling and it drops the sub.
describe("createBridgeServerConfig (#386)", () => {
  it("sets subscriptionOptions with zero randomization", () => {
    const cfg = createBridgeServerConfig({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productId: 0x8000,
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any);
    // biome-ignore lint/suspicious/noExplicitAny: inspect network config
    expect((cfg.network as any).subscriptionOptions).toEqual({
      minInterval: Seconds(2),
      maxInterval: Seconds(60),
      randomizationWindow: Seconds(0),
    });
  });
});
