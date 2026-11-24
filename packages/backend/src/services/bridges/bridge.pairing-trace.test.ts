import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Environment,
  LogDestination,
  Logger,
  LogLevel,
  VariableService,
} from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, expect, it, vi } from "vitest";
import type { LoggerService } from "../../core/app/logger.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { Bridge } from "./bridge.js";
import { BridgeDataProvider } from "./bridge-data-provider.js";
import type { BridgeEndpointManager } from "./bridge-endpoint-manager.js";

const dir = mkdtempSync(join(tmpdir(), "hamh-pairing-trace-"));
const cleanup: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse())
    await close().catch(() => {});
  delete Logger.destinations.capture;
  rmSync(dir, { recursive: true, force: true });
});

function env() {
  const e = new Environment("test", Environment.default);
  e.get(VariableService).set("storage.path", dir);
  // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
  return e as any;
}

it("logs commissioning Reads at debug and restores the level after", async () => {
  const lines: string[] = [];
  Logger.destinations.capture = LogDestination({
    name: "capture",
    level: LogLevel.INFO,
    write: (text, message) => {
      if (message.facility === "InteractionServer") lines.push(text);
    },
  });
  const log = {
    debug: vi.fn(),
    debugCtx: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const bridge = new Bridge(
    env(),
    { get: () => log } as unknown as LoggerService,
    new BridgeDataProvider({
      id: "c0ffee00c0ffee00c0ffee00c0ffee00",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [] },
      featureFlags: {},
      basicInformation: { vendorId: 0xfff1, productId: 0x8000 },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
    {
      root: new AggregatorEndpoint("aggregator"),
      devices: [],
      failedEntities: [],
      setTopologyChangeHandler() {},
      refreshDevices: async () => true,
      startObserving: async () => {},
      stopObserving() {},
      startPlugins: async () => {},
      stopPlugins: async () => {},
    } as unknown as BridgeEndpointManager,
  );
  cleanup.push(
    () => bridge.server.close(),
    () => bridge.stop(),
  );
  await bridge.server.construction;
  await bridge.start();

  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const { commissioning, network } = bridge.server.state as any;
  const controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      environment: env(),
      id: "pairing-trace-controller",
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  cleanup.push(() => controller.close());
  await controller.start();
  const client = await controller.peers.forDescriptor({
    addresses: [
      { type: "udp", ip: "127.0.0.1", port: network.operationalPort },
    ],
    deviceIdentifier: "pairing-trace",
    D: commissioning.discriminator,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: commissioning.passcode,
    discriminator: commissioning.discriminator,
    autoSubscribe: false,
    autoStateInitialize: true,
  });

  expect(lines.some((l) => l.includes("Read «"))).toBe(true);
  await vi.waitFor(() =>
    expect("InteractionServer" in Logger.facilityLevels).toBe(false),
  );
}, 60_000);
