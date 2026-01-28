import ComputerIcon from "@mui/icons-material/Computer";
import MemoryIcon from "@mui/icons-material/Memory";
import NetworkIcon from "@mui/icons-material/NetworkPing";
import StorageIcon from "@mui/icons-material/Storage";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";

interface SystemInfo {
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

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export const SystemInfo = () => {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSystemInfo = async () => {
      try {
        const res = await fetch("/api/system/info");
        if (res.ok) {
          const data = await res.json();
          setSystemInfo(data);
        }
      } catch (error) {
        console.error("Failed to fetch system info:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSystemInfo();
    const interval = setInterval(fetchSystemInfo, 30000); // Update every 30 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Typography>Loading system information...</Typography>
        </CardContent>
      </Card>
    );
  }

  if (!systemInfo) {
    return (
      <Card>
        <CardContent>
          <Typography color="error">
            Failed to load system information
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const memoryUsagePercent =
    (systemInfo.memory.used / systemInfo.memory.total) * 100;
  const storageUsagePercent =
    (systemInfo.storage.used / systemInfo.storage.total) * 100;

  return (
    <Card>
      <CardContent>
        <Typography
          variant="h6"
          gutterBottom
          sx={{ display: "flex", alignItems: "center", gap: 1 }}
        >
          <ComputerIcon />
          System Information
        </Typography>

        <Grid container spacing={3}>
          {/* Basic Info */}
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  Application
                </Typography>
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">Version:</Typography>
                    <Chip
                      label={systemInfo.version}
                      size="small"
                      color="primary"
                    />
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">Node.js:</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {systemInfo.nodeVersion}
                    </Typography>
                  </Box>
                </Stack>
              </Box>

              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  System
                </Typography>
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">Hostname:</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {systemInfo.hostname}
                    </Typography>
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">Platform:</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {systemInfo.platform} ({systemInfo.arch})
                    </Typography>
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">Uptime:</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {formatUptime(systemInfo.uptime)}
                    </Typography>
                  </Box>
                </Stack>
              </Box>
            </Stack>
          </Grid>

          {/* Resources */}
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={2}>
              <Box>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  sx={{ display: "flex", alignItems: "center", gap: 1 }}
                >
                  <MemoryIcon />
                  Memory Usage
                </Typography>
                <Box sx={{ mt: 1 }}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      mb: 1,
                    }}
                  >
                    <Typography variant="body2">
                      {formatBytes(systemInfo.memory.used)} /{" "}
                      {formatBytes(systemInfo.memory.total)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {memoryUsagePercent.toFixed(1)}%
                    </Typography>
                  </Box>
                  <Box
                    sx={{
                      height: 8,
                      backgroundColor: "action.hover",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        width: `${memoryUsagePercent}%`,
                        backgroundColor:
                          memoryUsagePercent > 80
                            ? "error.main"
                            : memoryUsagePercent > 60
                              ? "warning.main"
                              : "success.main",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </Box>
                </Box>
              </Box>

              <Box>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  sx={{ display: "flex", alignItems: "center", gap: 1 }}
                >
                  <StorageIcon />
                  Storage Usage
                </Typography>
                <Box sx={{ mt: 1 }}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      mb: 1,
                    }}
                  >
                    <Typography variant="body2">
                      {formatBytes(systemInfo.storage.used)} /{" "}
                      {formatBytes(systemInfo.storage.total)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {storageUsagePercent.toFixed(1)}%
                    </Typography>
                  </Box>
                  <Box
                    sx={{
                      height: 8,
                      backgroundColor: "action.hover",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        width: `${storageUsagePercent}%`,
                        backgroundColor:
                          storageUsagePercent > 80
                            ? "error.main"
                            : storageUsagePercent > 60
                              ? "warning.main"
                              : "success.main",
                        transition: "width 0.3s ease",
                      }}
                    />
                  </Box>
                </Box>
              </Box>
            </Stack>
          </Grid>

          {/* Network Interfaces */}
          <Grid size={{ xs: 12 }}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ display: "flex", alignItems: "center", gap: 1 }}
            >
              <NetworkIcon />
              Network Interfaces
            </Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>
              {systemInfo.network.interfaces.map((iface) => (
                <Box
                  key={`${iface.name}-${iface.address}`}
                  sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <Typography variant="body2">{iface.name}</Typography>
                  <Chip
                    label={`${iface.address} (${iface.family})`}
                    size="small"
                    variant="outlined"
                  />
                </Box>
              ))}
            </Stack>
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
};
