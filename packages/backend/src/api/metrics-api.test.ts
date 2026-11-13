import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import { metricsApi } from "./metrics-api.js";

const bridge = (id: string, status: string, deviceCount: number) => ({
  id,
  data: { name: id, status, deviceCount },
});

describe("prometheus metrics", () => {
  it("writes HELP and TYPE once per metric with samples grouped", async () => {
    const bridgeService = {
      bridges: [bridge("a", "running", 2), bridge("b", "stopped", 3)],
    } as unknown as BridgeService;
    const app = express().use(
      "/metrics",
      metricsApi(
        bridgeService,
        {} as HomeAssistantClient,
        { entities: {}, devices: {} } as unknown as HomeAssistantRegistry,
        Date.now(),
      ),
    );
    const server = app.listen(0);
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const text = await fetch(
        `http://127.0.0.1:${port}/metrics/prometheus`,
      ).then((res) => res.text());
      const lines = text.split("\n");
      for (const name of ["hamh_bridge_status", "hamh_bridge_devices"]) {
        expect(lines.filter((l) => l === `# TYPE ${name} gauge`)).toHaveLength(
          1,
        );
        expect(
          lines.filter((l) => l.startsWith(`# HELP ${name} `)),
        ).toHaveLength(1);
        const type = lines.indexOf(`# TYPE ${name} gauge`);
        expect(lines.slice(type + 1, type + 3)).toEqual([
          expect.stringMatching(new RegExp(`^${name}\\{bridge_id="a"`)),
          expect.stringMatching(new RegExp(`^${name}\\{bridge_id="b"`)),
        ]);
      }
      expect(text).toContain(
        'hamh_bridge_status{bridge_id="a",bridge_name="a"} 1',
      );
      expect(text).toContain(
        'hamh_bridge_devices{bridge_id="b",bridge_name="b"} 3',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
