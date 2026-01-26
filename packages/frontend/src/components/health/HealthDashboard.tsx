import AutorenewIcon from "@mui/icons-material/Autorenew";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DevicesIcon from "@mui/icons-material/Devices";
import ErrorIcon from "@mui/icons-material/Error";
import MemoryIcon from "@mui/icons-material/Memory";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";

interface BridgeHealthInfo {
  id: string;
  name: string;
  status: string;
  statusReason?: string;
  port: number;
  deviceCount: number;
  fabricCount: number;
  fabrics: Array<{
    fabricIndex: number;
    label: string;
    rootVendorId: number;
  }>;
  failedEntityCount: number;
}

interface DetailedHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    bridges: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
    };
  };
  bridgeDetails: BridgeHealthInfo[];
  recovery: {
    enabled: boolean;
    lastRecoveryAttempt?: string;
    recoveryCount: number;
  };
}

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const getVendorName = (vendorId: number): string => {
  const vendors: Record<number, string> = {
    4996: "Google",
    4937: "Apple",
    4448: "Amazon",
    4939: "Samsung",
  };
  return vendors[vendorId] ?? `Vendor ${vendorId}`;
};

export function HealthDashboard() {
  const [health, setHealth] = useState<DetailedHealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("api/health/detailed");
      if (res.ok) {
        const data = (await res.json()) as DetailedHealthStatus;
        setHealth(data);
        setError(null);
      } else {
        setError("Failed to fetch health status");
      }
    } catch {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleRestart = async (bridgeId: string) => {
    try {
      await fetch(`api/matter/bridges/${bridgeId}/actions/restart`, {
        method: "POST",
      });
      fetchHealth();
    } catch {
      setError("Failed to restart bridge");
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !health) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error ?? "Unable to load health status"}
      </Alert>
    );
  }

  const statusIcon =
    health.status === "healthy" ? (
      <CheckCircleIcon color="success" />
    ) : health.status === "degraded" ? (
      <WarningIcon color="warning" />
    ) : (
      <ErrorIcon color="error" />
    );

  return (
    <Box sx={{ p: 2 }}>
      <Box
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        mb={2}
      >
        <Box display="flex" alignItems="center" gap={1}>
          {statusIcon}
          <Typography variant="h5">System Health</Typography>
          <Chip
            label={health.status.toUpperCase()}
            color={
              health.status === "healthy"
                ? "success"
                : health.status === "degraded"
                  ? "warning"
                  : "error"
            }
            size="small"
          />
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={fetchHealth}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              Version
            </Typography>
            <Typography variant="h6">{health.version}</Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              Uptime
            </Typography>
            <Typography variant="h6">{formatUptime(health.uptime)}</Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              Bridges
            </Typography>
            <Chip
              label={`${health.services.bridges.running}/${health.services.bridges.total} Running`}
              color={
                health.services.bridges.failed > 0
                  ? "error"
                  : health.services.bridges.stopped > 0
                    ? "warning"
                    : "success"
              }
              size="small"
            />
          </Paper>
        </Grid>
      </Grid>

      <Divider sx={{ my: 3 }} />

      <Box display="flex" alignItems="center" gap={1} mb={2}>
        <MemoryIcon />
        <Typography variant="h6">Bridge Status</Typography>
      </Box>

      <Grid container spacing={2}>
        {health.bridgeDetails.map((bridge) => (
          <Grid size={{ xs: 12, md: 6 }} key={bridge.id}>
            <Card
              variant="outlined"
              sx={{
                borderColor:
                  bridge.status === "running"
                    ? "success.main"
                    : bridge.status === "failed"
                      ? "error.main"
                      : "warning.main",
              }}
            >
              <CardContent>
                <Box
                  display="flex"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <Box display="flex" alignItems="center" gap={1}>
                    <DevicesIcon />
                    <Typography variant="subtitle1" fontWeight="bold">
                      {bridge.name}
                    </Typography>
                  </Box>
                  <Box display="flex" alignItems="center" gap={1}>
                    <Chip
                      label={bridge.status.toUpperCase()}
                      color={
                        bridge.status === "running"
                          ? "success"
                          : bridge.status === "failed"
                            ? "error"
                            : "warning"
                      }
                      size="small"
                    />
                    {bridge.status === "failed" && (
                      <Tooltip title="Restart Bridge">
                        <IconButton
                          size="small"
                          onClick={() => handleRestart(bridge.id)}
                        >
                          <AutorenewIcon />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                </Box>

                {bridge.statusReason && (
                  <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                    {bridge.statusReason}
                  </Typography>
                )}

                <Box sx={{ mt: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Port: {bridge.port} | Devices: {bridge.deviceCount} |
                    Fabrics: {bridge.fabricCount}
                    {bridge.failedEntityCount > 0 && (
                      <Chip
                        label={`${bridge.failedEntityCount} failed`}
                        color="error"
                        size="small"
                        sx={{ ml: 1 }}
                      />
                    )}
                  </Typography>
                </Box>

                {bridge.fabrics.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      Connected to:
                    </Typography>
                    <Box display="flex" gap={0.5} flexWrap="wrap" mt={0.5}>
                      {bridge.fabrics.map((fabric) => (
                        <Chip
                          key={fabric.fabricIndex}
                          label={
                            fabric.label || getVendorName(fabric.rootVendorId)
                          }
                          size="small"
                          variant="outlined"
                        />
                      ))}
                    </Box>
                  </Box>
                )}
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {health.recovery.enabled && (
        <>
          <Divider sx={{ my: 3 }} />
          <Box display="flex" alignItems="center" gap={1} mb={1}>
            <AutorenewIcon />
            <Typography variant="h6">Auto Recovery</Typography>
            <Chip label="Enabled" color="success" size="small" />
          </Box>
          <Typography variant="body2" color="text.secondary">
            Recovery attempts: {health.recovery.recoveryCount}
            {health.recovery.lastRecoveryAttempt &&
              ` | Last attempt: ${new Date(health.recovery.lastRecoveryAttempt).toLocaleString()}`}
          </Typography>
        </>
      )}
    </Box>
  );
}
