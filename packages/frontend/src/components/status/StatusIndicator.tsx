import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import SyncIcon from "@mui/icons-material/Sync";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { useEffect, useState } from "react";
import { useWebSocketStatus } from "../../contexts/WebSocketContext.tsx";

interface HealthStatus {
  status: "healthy" | "unhealthy";
  version: string;
  uptime: number;
  bridges: {
    total: number;
    running: number;
    stopped: number;
    failed: number;
  };
  homeAssistant: {
    connected: boolean;
  };
}

export function StatusIndicator() {
  const { isConnected: wsConnected } = useWebSocketStatus();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        // Use relative URL to support Home Assistant ingress
        const res = await fetch("api/health");
        if (res.ok) {
          const data = (await res.json()) as HealthStatus;
          setHealth(data);
          setHealthError(false);
        } else {
          setHealthError(true);
        }
      } catch {
        setHealthError(true);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const isHealthy = health?.status === "healthy" && !healthError;
  const allBridgesRunning =
    health && health.bridges.running === health.bridges.total;

  const tooltipContent = health ? (
    <Box sx={{ p: 0.5 }}>
      <div>
        <strong>Version:</strong> {health.version}
      </div>
      <div>
        <strong>Uptime:</strong> {formatUptime(health.uptime)}
      </div>
      <div>
        <strong>Bridges:</strong> {health.bridges.running}/
        {health.bridges.total} running
        {health.bridges.failed > 0 && ` (${health.bridges.failed} failed)`}
      </div>
      <div>
        <strong>Home Assistant:</strong>{" "}
        {health.homeAssistant.connected ? "Connected" : "Disconnected"}
      </div>
      <div>
        <strong>WebSocket:</strong> {wsConnected ? "Connected" : "Disconnected"}
      </div>
    </Box>
  ) : (
    "Loading health status..."
  );

  const getStatusIcon = () => {
    if (healthError || !isHealthy) {
      return <ErrorIcon fontSize="small" />;
    }
    if (!allBridgesRunning) {
      return <SyncIcon fontSize="small" />;
    }
    return <CheckCircleIcon fontSize="small" />;
  };

  const getStatusColor = (): "success" | "warning" | "error" => {
    if (healthError || !isHealthy) {
      return "error";
    }
    if (!allBridgesRunning || !wsConnected) {
      return "warning";
    }
    return "success";
  };

  const getStatusLabel = (): string => {
    if (healthError) {
      return "Error";
    }
    if (!isHealthy) {
      return "Unhealthy";
    }
    if (!wsConnected) {
      return "Offline";
    }
    if (!allBridgesRunning) {
      return "Starting";
    }
    return "Online";
  };

  return (
    <Tooltip title={tooltipContent} arrow>
      <Chip
        icon={getStatusIcon()}
        label={getStatusLabel()}
        color={getStatusColor()}
        size="small"
        variant="outlined"
        sx={{
          borderRadius: 1,
          "& .MuiChip-icon": {
            color: "inherit",
          },
        }}
      />
    </Tooltip>
  );
}
