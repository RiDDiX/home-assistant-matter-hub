import type { AddressInfo } from "node:net";
import type os from "node:os";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import type { LoggerService } from "../core/app/logger.js";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { diagnosticApi } from "./diagnostic-api.js";

const FIXTURE: ReturnType<typeof os.networkInterfaces> = {
  lo: [
    {
      address: "127.0.0.1",
      netmask: "255.0.0.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: true,
      cidr: "127.0.0.1/8",
    },
  ],
  enx001122334455: [
    {
      address: "192.168.7.20",
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:11:22:33:44:55",
      internal: false,
      cidr: "192.168.7.20/24",
    },
    {
      address: "fe90::1",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "00:11:22:33:44:55",
      internal: false,
      cidr: "fe90::1/64",
      scopeid: 2,
    },
    {
      address: "fd12:3456:789a::20",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "00:11:22:33:44:55",
      internal: false,
      cidr: "fd12:3456:789a::20/64",
      scopeid: 0,
    },
    {
      address: "2001:db8:1::20",
      netmask: "ffff:ffff:ffff:ffff::",
      family: "IPv6",
      mac: "00:11:22:33:44:55",
      internal: false,
      cidr: "2001:db8:1::20/64",
      scopeid: 0,
    },
  ],
};

vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:os")>();
  const networkInterfaces = () => FIXTURE;
  return {
    ...real,
    networkInterfaces,
    default: { ...real, networkInterfaces },
  };
});

const sessionInfo = {
  sessions: [
    {
      id: 7,
      peerNodeId: "0x1234",
      fabricIndex: 1,
      subscriptionCount: 2,
      subscriptions: [],
      lastActiveMsAgo: 10,
      lastAnyActivityMsAgo: 10,
      lastImRequestMsAgo: 20,
      lastCommandImRequestMsAgo: null,
      subscribesLast30Min: 0,
      giveUpsLast30Min: 0,
      wedgeV2WouldRotate: false,
      isPeerActive: true,
      ageMsFromOpen: 1000,
    },
  ],
  totalSessions: 1,
  totalSubscriptions: 2,
  fabrics: [{ fabricIndex: 1, sessions: 1, subscriptions: 2 }],
};

const bridge = {
  data: {
    id: "bridge-one",
    name: "Living Room",
    status: "running",
    port: 5540,
    deviceCount: 3,
    failedEntities: [],
  },
  getSessionInfo: () => sessionInfo,
};

const bridgeService = { bridges: [bridge] } as unknown as BridgeService;
const haClient = { connection: { connected: true } } as HomeAssistantClient;
const haRegistry = {
  entities: {},
  devices: {},
} as unknown as HomeAssistantRegistry;
const logger = {
  level: "DEBUG",
  protocolLevel: "INFO",
} as unknown as LoggerService;

async function withRouter(fn: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(
    "/diagnostic",
    diagnosticApi(
      bridgeService,
      haClient,
      haRegistry,
      "1.2.3",
      Date.now(),
      logger,
      undefined,
      true,
    ),
  );
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("diagnosticApi", () => {
  it("reports log level, network and per bridge sessions", async () => {
    await withRouter(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/diagnostic/export?anonymize=false`);
      expect(res.status).toBe(200);
      const report = await res.json();
      expect(report.logLevel).toBe("DEBUG");
      expect(report.protocolLogLevel).toBe("INFO");
      expect(report.network.interfaces.length).toBeGreaterThan(0);
      expect(report.network.checks.length).toBeGreaterThan(0);
      expect(report.bridges[0].sessions).toEqual(sessionInfo);
    });
  });

  it("redacts interface addresses when anonymized", async () => {
    await withRouter(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/diagnostic/export`);
      const report = await res.json();
      const nic = report.network.interfaces.find(
        (i: { internal: boolean }) => !i.internal,
      );
      expect(nic).toEqual({
        name: "enx[MAC]",
        ipv4: ["[IP]"],
        ipv6: ["[IPv6 link-local]", "[IPv6 ULA]", "[IPv6 GUA]"],
        mac: "[MAC]",
        internal: false,
      });
      const dump = JSON.stringify(report.network);
      for (const raw of [
        "192.168.7.20",
        "fe90::1",
        "fd12:3456:789a::20",
        "2001:db8:1::20",
        "00:11:22:33:44:55",
        "enx001122334455",
        "127.0.0.1",
      ]) {
        expect(dump).not.toContain(raw);
      }
      // Session diagnostics stay readable.
      expect(report.bridges[0].sessions.sessions[0].peerNodeId).toBe("0x1234");
    });
  });
});
