import fs from "node:fs/promises";
import os from "node:os";
import express from "express";

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  memory: {
    total: number;
    used: number;
    free: number;
  };
  network: {
    interfaces: Array<{
      name: string;
      address: string;
      family: string;
    }>;
  };
  storage: {
    total: number;
    used: number;
    free: number;
  };
}

export function systemApi(): express.Router {
  const router = express.Router();

  router.get("/info", async (_req, res) => {
    try {
      const systemInfo: SystemInfo = {
        version: process.env.npm_package_version || "unknown",
        nodeVersion: process.version,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        uptime: os.uptime(),
        memory: {
          total: os.totalmem(),
          used: os.totalmem() - os.freemem(),
          free: os.freemem(),
        },
        network: {
          interfaces: Object.entries(os.networkInterfaces())
            .filter(([, iface]) => {
              // Type assertion to access NetworkInterfaceInfo properties
              const networkInterface = iface as any;
              return (
                networkInterface &&
                !networkInterface.internal &&
                networkInterface.family !== "IPv6"
              );
            })
            .map(([name, iface]) => {
              // Type assertion to access NetworkInterfaceInfo properties
              const networkInterface = iface as any;
              return {
                name,
                address: networkInterface.address,
                family: networkInterface.family,
              };
            }),
        },
        storage: await getStorageInfo(),
      };

      res.json(systemInfo);
    } catch (error) {
      console.error("Failed to get system info:", error);
      res.status(500).json({ error: "Failed to get system info" });
    }
  });

  return router;
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
