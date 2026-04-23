import type { BridgeStatus } from "@home-assistant-matter-hub/common";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import StopCircleIcon from "@mui/icons-material/StopCircle";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import { useColorScheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { Handle, type NodeProps, Position } from "@xyflow/react";

export interface BridgeNodeData {
  label: string;
  status: BridgeStatus;
  port: number;
  deviceCount: number;
  failedCount: number;
  fabricCount: number;
  icon?: string;
  [key: string]: unknown;
}

type StatusStyle = {
  color: string;
  bg: string;
  border: string;
  Icon: typeof CheckCircleIcon;
};

function getStatusConfig(isDark: boolean): Record<string, StatusStyle> {
  return {
    running: {
      color: isDark ? "#81c784" : "#2e7d32",
      bg: isDark ? "#1b3a1b" : "#e8f5e9",
      border: "#4caf50",
      Icon: CheckCircleIcon,
    },
    starting: {
      color: isDark ? "#ffb74d" : "#ed6c02",
      bg: isDark ? "#3a2a10" : "#fff3e0",
      border: "#ff9800",
      Icon: HourglassEmptyIcon,
    },
    stopped: {
      color: isDark ? "#bdbdbd" : "#757575",
      bg: isDark ? "#2a2a2a" : "#f5f5f5",
      border: isDark ? "#616161" : "#bdbdbd",
      Icon: StopCircleIcon,
    },
    failed: {
      color: isDark ? "#ef5350" : "#d32f2f",
      bg: isDark ? "#3a1515" : "#ffebee",
      border: "#f44336",
      Icon: ErrorIcon,
    },
  };
}

export const BridgeNode = ({ data }: NodeProps) => {
  const { label, status, port, deviceCount, failedCount, fabricCount } =
    data as unknown as BridgeNodeData;
  const { mode } = useColorScheme();
  const isDark = mode === "dark";
  const statusCfg = getStatusConfig(isDark);
  const config = statusCfg[status] ?? statusCfg.stopped;
  const { Icon } = config;

  return (
    <Box
      sx={{
        background: config.bg,
        border: `2px solid ${config.border}`,
        borderRadius: 2,
        px: 2,
        py: 1.5,
        minWidth: 180,
        maxWidth: 220,
        boxShadow: "0 2px 12px rgba(0,0,0,0.08)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0 }}
        id="top"
      />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0 }}
        id="bottom"
      />

      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 0.5 }}>
        <Icon sx={{ fontSize: 16, color: config.color }} />
        <Typography
          variant="subtitle2"
          noWrap
          sx={{ fontWeight: 700, color: config.color }}
        >
          {label}
        </Typography>
      </Box>

      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block" }}
      >
        Port {port}
      </Typography>

      <Box sx={{ display: "flex", gap: 0.5, mt: 0.5, flexWrap: "wrap" }}>
        <Chip
          label={`${deviceCount} devices`}
          size="small"
          sx={{ fontSize: "0.65rem", height: 20 }}
        />
        {fabricCount > 0 && (
          <Chip
            label={`${fabricCount} fabrics`}
            size="small"
            color="primary"
            variant="outlined"
            sx={{ fontSize: "0.65rem", height: 20 }}
          />
        )}
        {failedCount > 0 && (
          <Chip
            label={`${failedCount} failed`}
            size="small"
            color="error"
            sx={{ fontSize: "0.65rem", height: 20 }}
          />
        )}
      </Box>
    </Box>
  );
};
