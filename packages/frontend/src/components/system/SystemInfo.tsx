import ComputerIcon from "@mui/icons-material/Computer";
import MemoryIcon from "@mui/icons-material/Memory";
import NetworkIcon from "@mui/icons-material/NetworkPing";
import StorageIcon from "@mui/icons-material/Storage";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface NetworkInterface {
  name: string;
  address: string;
  family: string;
  mac: string;
  internal: boolean;
}

interface SystemInfo {
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

function UsageBar({
  percent,
  warnAt,
  errorAt,
  label,
}: {
  percent: number;
  warnAt: number;
  errorAt: number;
  label: string;
}) {
  const value = Math.min(Math.max(percent, 0), 100);
  return (
    <LinearProgress
      variant="determinate"
      value={value}
      aria-label={label}
      color={value > errorAt ? "error" : value > warnAt ? "warning" : "success"}
      sx={{ height: 8, borderRadius: 4 }}
    />
  );
}

export const SystemInfo = () => {
  const { t } = useTranslation();
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiAvailable, setApiAvailable] = useState(true);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchSystemInfo = async () => {
      try {
        const res = await fetch("api/system/info");
        if (res.ok) {
          const data = await res.json();
          setSystemInfo(data);
          setApiAvailable(true);
        } else if (res.status === 404) {
          // API not available in this version - stop polling
          setApiAvailable(false);
          if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch {
        // Network error - don't spam console
      } finally {
        setLoading(false);
      }
    };

    fetchSystemInfo();
    intervalId = setInterval(fetchSystemInfo, 30000);

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, []);

  // Don't render if API is not available
  if (!apiAvailable) {
    return null;
  }

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Typography>{t("system.loading")}</Typography>
        </CardContent>
      </Card>
    );
  }

  if (!systemInfo) {
    return (
      <Card>
        <CardContent>
          <Typography color="error">{t("system.loadFailed")}</Typography>
        </CardContent>
      </Card>
    );
  }

  // the API guards against a zero total, local division showed NaN
  const memoryUsagePercent = systemInfo.memory.usagePercent;
  const storageUsagePercent = systemInfo.storage.usagePercent;
  const heapPercent =
    systemInfo.process.heapSizeLimit > 0
      ? (systemInfo.process.heapUsed / systemInfo.process.heapSizeLimit) * 100
      : 0;

  return (
    <Card>
      <CardContent>
        <Typography
          variant="h6"
          gutterBottom
          sx={{ display: "flex", alignItems: "center", gap: 1 }}
        >
          <ComputerIcon />
          {t("system.title")}
        </Typography>

        <Grid container spacing={3}>
          {/* Basic Info */}
          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  {t("system.application")}
                </Typography>
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("common.version")}:
                    </Typography>
                    <Chip
                      label={systemInfo.version}
                      size="small"
                      color="primary"
                    />
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("system.environment")}:
                    </Typography>
                    <Chip
                      label={systemInfo.environment}
                      size="small"
                      variant="outlined"
                      color={
                        systemInfo.environment === "Home Assistant Add-on"
                          ? "success"
                          : "default"
                      }
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
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("system.processUptime")}:
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {formatUptime(systemInfo.process.uptime)}
                    </Typography>
                  </Box>
                </Stack>
              </Box>

              <Box>
                <Typography variant="subtitle2" color="text.secondary">
                  {t("system.system")}
                </Typography>
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("system.hostname")}:
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {systemInfo.hostname}
                    </Typography>
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("system.platform")}:
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {systemInfo.platform} ({systemInfo.arch})
                    </Typography>
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">{t("system.cpu")}:</Typography>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ maxWidth: 200, textAlign: "right" }}
                      noWrap
                      title={systemInfo.cpuModel}
                    >
                      {systemInfo.cpuCount}x{" "}
                      {systemInfo.cpuModel.split("@")[0].trim()}
                    </Typography>
                  </Box>
                  <Box
                    sx={{ display: "flex", justifyContent: "space-between" }}
                  >
                    <Typography variant="body2">
                      {t("system.systemUptime")}:
                    </Typography>
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
                  {t("system.memoryUsage")}
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
                  <UsageBar
                    percent={memoryUsagePercent}
                    warnAt={60}
                    errorAt={80}
                    label={t("system.memoryUsage")}
                  />
                </Box>
              </Box>

              <Box>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  sx={{ display: "flex", alignItems: "center", gap: 1 }}
                >
                  <MemoryIcon />
                  {t("system.processMemory")}
                </Typography>
                <Box sx={{ mt: 1 }}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      mb: 0.5,
                    }}
                  >
                    <Typography variant="body2">
                      {t("health.rss")}: {formatBytes(systemInfo.process.rss)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t("health.heap")}:{" "}
                      {formatBytes(systemInfo.process.heapUsed)} /{" "}
                      {formatBytes(systemInfo.process.heapSizeLimit)}
                    </Typography>
                  </Box>
                  <UsageBar
                    percent={heapPercent}
                    warnAt={60}
                    errorAt={85}
                    label={t("system.processMemory")}
                  />
                </Box>
              </Box>

              <Box>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  sx={{ display: "flex", alignItems: "center", gap: 1 }}
                >
                  <StorageIcon />
                  {t("system.storageUsage")}
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
                  <UsageBar
                    percent={storageUsagePercent}
                    warnAt={60}
                    errorAt={80}
                    label={t("system.storageUsage")}
                  />
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
              {t("health.networkInterfaces")}
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
