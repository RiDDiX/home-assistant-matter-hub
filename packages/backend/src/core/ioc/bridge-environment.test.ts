import type { BridgeData } from "@home-assistant-matter-hub/common";
import { describe, expect, it, vi } from "vitest";
import { BridgeEnvironmentFactory } from "./bridge-environment.js";

// Building real environments needs HA and storage, so the two private
// builders are stubbed and only the choice between them is checked.
describe("BridgeEnvironmentFactory.create", () => {
  it.each([
    [{ appleAdaptiveTemperature: true }, "server"],
    [{ serverMode: true }, "server"],
    [{}, "normal"],
    [{ appleAdaptiveTemperature: false }, "normal"],
  ])("%o builds a %s bridge", async (featureFlags, expected) => {
    const factory = new BridgeEnvironmentFactory({} as never);
    const builders = factory as unknown as {
      createServerModeBridge(data: BridgeData): Promise<unknown>;
      createNormalBridge(data: BridgeData): Promise<unknown>;
    };
    vi.spyOn(builders, "createServerModeBridge").mockResolvedValue("server");
    vi.spyOn(builders, "createNormalBridge").mockResolvedValue("normal");

    const bridge = await factory.create({ id: "b", featureFlags } as never);
    expect(bridge).toBe(expected);
  });
});
