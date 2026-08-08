import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import SyncIcon from "@mui/icons-material/Sync";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWebSocketStatus } from "../../contexts/WebSocketContext.tsx";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  services: {
    bridges: {
      total: number;
      running: number;
      stopped: number;
    };
    homeAssistant: {
      connected: boolean;
    };
  };
}

export function StatusIndicator() {
  const { t } = useTranslation();
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
  const bridges = health?.services?.bridges;
  const allBridgesRunning =
    bridges && bridges.total > 0 && bridges.running === bridges.total;
  const noBridgesConfigured = bridges && bridges.total === 0;

  const tooltipContent = health ? (
    <Box sx={{ p: 0.5 }}>
      <div>
        <strong>{t("health.version")}:</strong>{" "}
        {health.version ?? t("status.unknown")}
      </div>
      <div>
        <strong>{t("health.uptime")}:</strong>{" "}
        {formatUptime(health.uptime ?? 0)}
      </div>
      {health.services?.bridges && (
        <div>
          <strong>{t("nav.bridges")}:</strong>{" "}
          {health.services.bridges.running ?? 0}/
          {health.services.bridges.total ?? 0}{" "}
          {t("common.running").toLowerCase()}
          {(health.services.bridges.stopped ?? 0) > 0 &&
            ` (${health.services.bridges.stopped} ${t("common.stopped").toLowerCase()})`}
        </div>
      )}
      {health.services?.homeAssistant && (
        <div>
          <strong>{t("health.homeAssistant")}:</strong>{" "}
          {health.services.homeAssistant.connected
            ? t("health.connected")
            : t("health.disconnected")}
        </div>
      )}
      <div>
        <strong>WebSocket:</strong>{" "}
        {wsConnected ? t("health.connected") : t("health.disconnected")}
      </div>
    </Box>
  ) : (
    t("status.loadingHealth")
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
      return t("status.error");
    }
    if (!isHealthy) {
      return t("status.unhealthy");
    }
    if (!wsConnected) {
      return t("common.offline");
    }
    if (noBridgesConfigured) {
      return t("status.noBridges");
    }
    if (!allBridgesRunning) {
      return t("common.starting");
    }
    return t("common.online");
  };

  return (
    <Tooltip title={tooltipContent} arrow>
      <Chip
        icon={getStatusIcon()}
        label={getStatusLabel()}
        color={getStatusColor()}
        size="small"
        variant="filled"
        sx={{
          borderRadius: 1,
          fontWeight: 600,
          "& .MuiChip-icon": {
            color: "inherit",
          },
        }}
      />
    </Tooltip>
  );
}
