import express from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";

export interface SystemMetrics {
  timestamp: string;
  uptime: number;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  bridges: {
    total: number;
    running: number;
    stopped: number;
    failed: number;
    totalDevices: number;
    totalFabrics: number;
  };
  homeAssistant: {
    connected: boolean;
    entities: number;
    devices: number;
  };
}

export interface PrometheusMetrics {
  text: string;
}

export function metricsApi(
  bridgeService: BridgeService,
  haClient: HomeAssistantClient,
  haRegistry: HomeAssistantRegistry,
  startTime: number,
): express.Router {
  const router = express.Router();

  router.get("/", (_, res) => {
    const memoryUsage = process.memoryUsage();
    const bridges = bridgeService.bridges;

    const running = bridges.filter((b) => b.data.status === "running").length;
    const stopped = bridges.filter((b) => b.data.status === "stopped").length;
    const failed = bridges.filter((b) => b.data.status === "failed").length;

    const totalDevices = bridges.reduce(
      (sum, b) => sum + b.data.deviceCount,
      0,
    );
    const totalFabrics = bridges.reduce(
      (sum, b) => sum + (b.data.commissioning?.fabrics?.length ?? 0),
      0,
    );

    const metrics: SystemMetrics = {
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - startTime) / 1000),
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      bridges: {
        total: bridges.length,
        running,
        stopped,
        failed,
        totalDevices,
        totalFabrics,
      },
      homeAssistant: {
        connected: haClient.connection?.connected ?? false,
        entities: Object.keys(haRegistry.entities).length,
        devices: Object.keys(haRegistry.devices).length,
      },
    };

    res.json(metrics);
  });

  router.get("/prometheus", (_, res) => {
    const memoryUsage = process.memoryUsage();
    const bridges = bridgeService.bridges;
    const uptime = Math.floor((Date.now() - startTime) / 1000);

    const running = bridges.filter((b) => b.data.status === "running").length;
    const stopped = bridges.filter((b) => b.data.status === "stopped").length;
    const failed = bridges.filter((b) => b.data.status === "failed").length;
    const totalDevices = bridges.reduce(
      (sum, b) => sum + b.data.deviceCount,
      0,
    );
    const totalFabrics = bridges.reduce(
      (sum, b) => sum + (b.data.commissioning?.fabrics?.length ?? 0),
      0,
    );

    const lines: string[] = [
      "# HELP hamh_uptime_seconds Application uptime in seconds",
      "# TYPE hamh_uptime_seconds gauge",
      `hamh_uptime_seconds ${uptime}`,
      "",
      "# HELP hamh_memory_heap_used_bytes Heap memory used in bytes",
      "# TYPE hamh_memory_heap_used_bytes gauge",
      `hamh_memory_heap_used_bytes ${memoryUsage.heapUsed}`,
      "",
      "# HELP hamh_memory_heap_total_bytes Total heap memory in bytes",
      "# TYPE hamh_memory_heap_total_bytes gauge",
      `hamh_memory_heap_total_bytes ${memoryUsage.heapTotal}`,
      "",
      "# HELP hamh_memory_rss_bytes Resident set size in bytes",
      "# TYPE hamh_memory_rss_bytes gauge",
      `hamh_memory_rss_bytes ${memoryUsage.rss}`,
      "",
      "# HELP hamh_bridges_total Total number of bridges",
      "# TYPE hamh_bridges_total gauge",
      `hamh_bridges_total ${bridges.length}`,
      "",
      "# HELP hamh_bridges_running Number of running bridges",
      "# TYPE hamh_bridges_running gauge",
      `hamh_bridges_running ${running}`,
      "",
      "# HELP hamh_bridges_stopped Number of stopped bridges",
      "# TYPE hamh_bridges_stopped gauge",
      `hamh_bridges_stopped ${stopped}`,
      "",
      "# HELP hamh_bridges_failed Number of failed bridges",
      "# TYPE hamh_bridges_failed gauge",
      `hamh_bridges_failed ${failed}`,
      "",
      "# HELP hamh_devices_total Total number of Matter devices",
      "# TYPE hamh_devices_total gauge",
      `hamh_devices_total ${totalDevices}`,
      "",
      "# HELP hamh_fabrics_total Total number of connected fabrics",
      "# TYPE hamh_fabrics_total gauge",
      `hamh_fabrics_total ${totalFabrics}`,
      "",
      "# HELP hamh_ha_connected Home Assistant connection status (1=connected, 0=disconnected)",
      "# TYPE hamh_ha_connected gauge",
      `hamh_ha_connected ${haClient.connection?.connected ? 1 : 0}`,
      "",
      "# HELP hamh_ha_entities_total Total number of Home Assistant entities",
      "# TYPE hamh_ha_entities_total gauge",
      `hamh_ha_entities_total ${Object.keys(haRegistry.entities).length}`,
      "",
      "# HELP hamh_ha_devices_total Total number of Home Assistant devices",
      "# TYPE hamh_ha_devices_total gauge",
      `hamh_ha_devices_total ${Object.keys(haRegistry.devices).length}`,
      "",
    ];

    for (const bridge of bridges) {
      const status = bridge.data.status === "running" ? 1 : 0;
      const safeName = bridge.data.name.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(
        `# HELP hamh_bridge_status Bridge status (1=running, 0=not running)`,
        `# TYPE hamh_bridge_status gauge`,
        `hamh_bridge_status{bridge_id="${bridge.id}",bridge_name="${safeName}"} ${status}`,
        "",
        `# HELP hamh_bridge_devices Number of devices on bridge`,
        `# TYPE hamh_bridge_devices gauge`,
        `hamh_bridge_devices{bridge_id="${bridge.id}",bridge_name="${safeName}"} ${bridge.data.deviceCount}`,
        "",
      );
    }

    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(lines.join("\n"));
  });

  return router;
}
