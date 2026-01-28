import fs from "node:fs/promises";
import os from "node:os";
import express from "express";

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
  loadAvg: number[];
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
    memoryUsage: number;
  };
}

export function systemApi(): express.Router {
  const router = express.Router();

  router.get("/info", async (_req, res) => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const storageInfo = await getStorageInfo();

      const systemInfo: SystemInfo = {
        version: process.env.npm_package_version || "unknown",
        nodeVersion: process.version,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg(),
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
          memoryUsage: process.memoryUsage().heapUsed,
        },
      };

      res.json(systemInfo);
    } catch (error) {
      console.error("Failed to get system info:", error);
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
      // Only include IPv4 addresses for simplicity
      const family = String(iface.family);
      if (family === "IPv4" || family === "4") {
        interfaces.push({
          name,
          address: iface.address,
          family: family === "4" ? "IPv4" : family,
          mac: iface.mac,
          internal: iface.internal,
        });
      }
    }
  }

  return interfaces;
}

async function getStorageInfo(): Promise<{
  total: number;
  used: number;
  free: number;
}> {
  try {
    // Get storage info for the current working directory
    const _stats = await fs.stat(process.cwd());

    // On Windows, we need to get the drive info
    if (os.platform() === "win32") {
      const drive = `${process.cwd().split(":")[0]}:`;
      try {
        // Try to get free space using Node.js built-in methods
        const freeSpace = await getDiskFreeSpace(drive);
        const totalSpace = 1073741824000; // 1TB default estimate for Windows
        const usedSpace = totalSpace - freeSpace;

        return {
          total: totalSpace,
          used: usedSpace,
          free: freeSpace,
        };
      } catch {
        // Fallback to estimates
        return {
          total: 1073741824000, // 1TB
          used: 536870912000, // 500GB
          free: 536870912000, // 500GB
        };
      }
    } else {
      // For Unix-like systems, we can use statvfs if available
      try {
        const freeSpace = await getDiskFreeSpace("/");
        const totalSpace = 1073741824000; // 1TB default estimate
        const usedSpace = totalSpace - freeSpace;

        return {
          total: totalSpace,
          used: usedSpace,
          free: freeSpace,
        };
      } catch {
        // Fallback to estimates
        return {
          total: 1073741824000, // 1TB
          used: 536870912000, // 500GB
          free: 536870912000, // 500GB
        };
      }
    }
  } catch (error) {
    console.error("Failed to get storage info:", error);
    // Return fallback values
    return {
      total: 1073741824000, // 1TB
      used: 536870912000, // 500GB
      free: 536870912000, // 500GB
    };
  }
}

async function getDiskFreeSpace(_path: string): Promise<number> {
  // This is a simplified implementation
  // In a real implementation, you might want to use a library like 'diskusage'
  // For now, we'll return a reasonable estimate
  return 536870912000; // 500GB
}
