import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import v8 from "node:v8";
import { Logger } from "@matter/general";
import express from "express";

const execAsync = promisify(exec);
const logger = Logger.get("SystemApi");

export interface NetworkInterface {
  name: string;
  address: string;
  family: string;
  mac: string;
  internal: boolean;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  cpuCount: number;
  cpuModel: string;
  loadAvg: number[];
  environment: string;
  memory: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  network: {
    interfaces: NetworkInterface[];
  };
  storage: {
    total: number;
    used: number;
    free: number;
    usagePercent: number;
  };
  process: {
    pid: number;
    uptime: number;
    rss: number;
    memoryUsage: number;
    heapTotal: number;
    heapUsed: number;
    heapSizeLimit: number;
    external: number;
  };
}

function detectEnvironment(): string {
  // Check for Home Assistant Add-on environment
  if (process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN) {
    return "Home Assistant Add-on";
  }
  // Check for Docker environment
  if (process.env.DOCKER_ENV === "true" || process.env.container === "docker") {
    return "Docker";
  }
  // Check for common Docker indicators
  try {
    const fs = require("node:fs");
    if (fs.existsSync("/.dockerenv")) {
      return "Docker";
    }
  } catch {
    // ignore
  }
  return "Standalone";
}

export interface GithubLatestRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  body?: string;
}

export function toUpdateCheckResponse(
  version: string,
  data: GithubLatestRelease,
  environment: string,
) {
  const latestVersion = data.tag_name.replace(/^v/, "");
  return {
    currentVersion: version,
    latestVersion,
    updateAvailable: version !== "0.0.0-dev" && latestVersion !== version,
    releaseUrl: data.html_url,
    publishedAt: data.published_at,
    releaseNotes: data.body || undefined,
    environment,
  };
}

export function systemApi(version: string): express.Router {
  const router = express.Router();

  router.get("/update-check", async (_req, res) => {
    try {
      const response = await fetch(
        "https://api.github.com/repos/riddix/home-assistant-matter-hub/releases/latest",
        {
          headers: { Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) {
        res.status(502).json({ error: "Failed to check for updates" });
        return;
      }
      const data = (await response.json()) as GithubLatestRelease;
      res.json(toUpdateCheckResponse(version, data, detectEnvironment()));
    } catch (error) {
      logger.error("Failed to check for updates:", error);
      res.status(500).json({ error: "Failed to check for updates" });
    }
  });

  router.get("/info", async (_req, res) => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const storageInfo = await getStorageInfo();

      const cpus = os.cpus();
      const memUsage = process.memoryUsage();

      const systemInfo: SystemInfo = {
        version,
        nodeVersion: process.version,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model || "Unknown",
        loadAvg: os.loadavg(),
        environment: detectEnvironment(),
        memory: {
          total: totalMem,
          used: usedMem,
          free: freeMem,
          usagePercent: Math.round((usedMem / totalMem) * 100),
        },
        network: {
          interfaces: getNetworkInterfaces(),
        },
        storage: {
          ...storageInfo,
          usagePercent:
            storageInfo.total > 0
              ? Math.round((storageInfo.used / storageInfo.total) * 100)
              : 0,
        },
        process: {
          pid: process.pid,
          uptime: process.uptime(),
          rss: memUsage.rss,
          memoryUsage: memUsage.heapUsed,
          heapTotal: memUsage.heapTotal,
          heapUsed: memUsage.heapUsed,
          heapSizeLimit: v8.getHeapStatistics().heap_size_limit,
          external: memUsage.external,
        },
      };

      res.json(systemInfo);
    } catch (error) {
      logger.error("Failed to get system info:", error);
      res.status(500).json({ error: "Failed to get system info" });
    }
  });

  return router;
}

function getNetworkInterfaces(): NetworkInterface[] {
  const interfaces: NetworkInterface[] = [];
  const networkInterfaces = os.networkInterfaces();

  for (const [name, ifaceList] of Object.entries(networkInterfaces)) {
    if (!ifaceList) continue;

    for (const iface of ifaceList) {
      // Include both IPv4 and IPv6 addresses
      const family = String(iface.family);
      const normalizedFamily =
        family === "4" ? "IPv4" : family === "6" ? "IPv6" : family;

      // Skip link-local IPv6 addresses (fe80::) for cleaner display
      if (normalizedFamily === "IPv6" && iface.address.startsWith("fe80:")) {
        continue;
      }

      interfaces.push({
        name,
        address: iface.address,
        family: normalizedFamily,
        mac: iface.mac,
        internal: iface.internal,
      });
    }
  }

  // Sort: IPv4 first, then IPv6, then by interface name
  interfaces.sort((a, b) => {
    if (a.family !== b.family) {
      return a.family === "IPv4" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return interfaces;
}

async function getStorageInfo(): Promise<{
  total: number;
  used: number;
  free: number;
}> {
  try {
    // Determine the path to check - use data directory if available
    const pathToCheck = getDataPath();

    if (os.platform() === "win32") {
      return await getWindowsStorageInfo(pathToCheck);
    } else {
      return await getUnixStorageInfo(pathToCheck);
    }
  } catch (error) {
    logger.error("Failed to get storage info:", error);
    return { total: 0, used: 0, free: 0 };
  }
}

/**
 * Get the data path to check storage for.
 * For Add-on: /data
 * For Docker: DATA_PATH env or /data
 * For Standalone: current working directory
 */
function getDataPath(): string {
  // Home Assistant Add-on uses /data
  if (process.env.SUPERVISOR_TOKEN || process.env.HASSIO_TOKEN) {
    return "/data";
  }
  // Docker might use DATA_PATH env
  if (process.env.DATA_PATH) {
    return process.env.DATA_PATH;
  }
  // Check if /data exists (common Docker mount point)
  try {
    const fsSync = require("node:fs");
    if (fsSync.existsSync("/data")) {
      return "/data";
    }
  } catch {
    // ignore
  }
  // Fallback to current working directory
  return process.cwd();
}

/**
 * Get storage info on Windows using PowerShell
 */
async function getWindowsStorageInfo(
  path: string,
): Promise<{ total: number; used: number; free: number }> {
  try {
    const drive = `${path.split(":")[0]}:`;
    const { stdout } = await execAsync(
      `powershell -Command "Get-PSDrive -Name '${drive.replace(":", "")}' | Select-Object Used,Free | ConvertTo-Json"`,
    );
    const data = JSON.parse(stdout.trim());
    const used = Number(data.Used) || 0;
    const free = Number(data.Free) || 0;
    const total = used + free;
    return { total, used, free };
  } catch {
    // Fallback: try wmic
    try {
      const drive = `${path.split(":")[0]}:`;
      const { stdout } = await execAsync(
        `wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /format:csv`,
      );
      const lines = stdout.trim().split("\n").filter(Boolean);
      if (lines.length >= 2) {
        const values = lines[1].split(",");
        const free = Number(values[1]) || 0;
        const total = Number(values[2]) || 0;
        const used = total - free;
        return { total, used, free };
      }
    } catch {
      // ignore
    }
    return { total: 0, used: 0, free: 0 };
  }
}

/**
 * Get storage info on Unix-like systems using df command
 */
async function getUnixStorageInfo(
  path: string,
): Promise<{ total: number; used: number; free: number }> {
  try {
    // Use df with 1K blocks for accuracy, -P for POSIX output
    const { stdout } = await execAsync(`df -Pk "${path}" 2>/dev/null`);
    const lines = stdout.trim().split("\n");

    if (lines.length >= 2) {
      // Parse df output: Filesystem 1K-blocks Used Available Use% Mounted
      const parts = lines[1].split(/\s+/);
      if (parts.length >= 4) {
        const total = Number(parts[1]) * 1024; // Convert from 1K blocks to bytes
        const used = Number(parts[2]) * 1024;
        const free = Number(parts[3]) * 1024;
        return { total, used, free };
      }
    }
  } catch {
    // ignore
  }
  return { total: 0, used: 0, free: 0 };
}
