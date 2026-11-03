import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import SyncIcon from "@mui/icons-material/Sync";
import WarningIcon from "@mui/icons-material/Warning";
import Box from "@mui/material/Box";
import Chip, { type ChipProps } from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useWebSocketStatus } from "../../contexts/WebSocketContext.tsx";
import { navigation } from "../../routes.tsx";

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
  const { isConnected: wsConnected, closedOnce } = useWebSocketStatus();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthError, setHealthError] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the socket drops or comes back
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        // Use relative URL to support Home Assistant ingress
        const res = await fetch("api/health");
        // unhealthy answers 503 but still sends the status body
        if (res.ok || res.status === 503) {
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
  }, [wsConnected]);

  const formatUptime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const bridges = health?.services?.bridges;
  const allBridgesRunning =
    bridges && bridges.total > 0 && bridges.running === bridges.total;
  const noBridgesConfigured = bridges && bridges.total === 0;

  const tooltipContent = healthError ? (
    t("health.connectionError")
  ) : health ? (
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

  let color: ChipProps["color"] = "success";
  let icon: ReactElement = <CheckCircleIcon fontSize="small" />;
  let label = t("common.online");
  if (healthError) {
    color = "error";
    icon = <ErrorIcon fontSize="small" />;
    label = t("status.error");
  } else if (!health) {
    color = "default";
    icon = <SyncIcon fontSize="small" />;
    label = t("common.loading");
  } else if (health.status === "unhealthy") {
    color = "error";
    icon = <ErrorIcon fontSize="small" />;
    label = t("status.unhealthy");
  } else if (closedOnce && !wsConnected) {
    color = "warning";
    icon = <SyncIcon fontSize="small" />;
    label = t("common.offline");
  } else if (health.status === "degraded") {
    color = "warning";
    icon = <WarningIcon fontSize="small" />;
    label = t("status.degraded");
  } else if (noBridgesConfigured) {
    color = "warning";
    icon = <SyncIcon fontSize="small" />;
    label = t("status.noBridges");
  } else if (!allBridgesRunning) {
    color = "warning";
    icon = <SyncIcon fontSize="small" />;
    label = t("common.starting");
  }

  return (
    <Tooltip title={tooltipContent} arrow>
      <Chip
        component={Link}
        to={navigation.health}
        clickable
        icon={icon}
        label={label}
        color={color}
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
