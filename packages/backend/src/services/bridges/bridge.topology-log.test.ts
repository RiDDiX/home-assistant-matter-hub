import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { BasicInformationServer } from "@matter/main/behaviors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../../core/app/logger.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { Bridge } from "./bridge.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";

let dir: string;
let bridge: Bridge | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-bridge-topology-"));
});

afterEach(async () => {
  await bridge?.server.close().catch(() => {});
  bridge = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("Bridge topology change", () => {
  it("logs the new configuration version at info", async () => {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    const provider = new BridgeDataProvider({
      id: "bridge-topology",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [] },
      featureFlags: {},
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any);
    let handler:
      | ((change: () => Promise<unknown>) => Promise<void>)
      | undefined;
    const endpointManager = {
      root: new AggregatorEndpoint("aggregator"),
      setTopologyChangeHandler(h: typeof handler) {
        handler = h;
      },
    } as unknown as BridgeEndpointManager;
    const log = {
      debug: vi.fn(),
      debugCtx: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger = { get: () => log } as unknown as LoggerService;
    bridge = new Bridge(env, logger, provider, endpointManager);
    await bridge.server.construction;

    await handler?.(async () => undefined);

    const version = bridge.server.stateOf(
      BasicInformationServer,
    ).configurationVersion;
    expect(version).toBe(2);
    expect(log.info).toHaveBeenCalledWith(
      "Matter topology changed, ConfigurationVersion is now 2",
    );
  });
});
