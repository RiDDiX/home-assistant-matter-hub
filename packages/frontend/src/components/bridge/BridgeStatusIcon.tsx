import { BridgeStatus } from "@home-assistant-matter-hub/common";
import CheckCircle from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import PauseCircle from "@mui/icons-material/PauseCircle";
import Sync from "@mui/icons-material/Sync";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";

export interface BridgeStatusIconProps {
  status: BridgeStatus;
  reason?: string;
}

const statusConfig: Record<
  BridgeStatus,
  {
    label: string;
    color: "success" | "warning" | "error" | "info";
    icon: React.ReactElement;
  }
> = {
  [BridgeStatus.Starting]: {
    label: "Starting",
    color: "info",
    icon: <Sync fontSize="small" />,
  },
  [BridgeStatus.Running]: {
    label: "Running",
    color: "success",
    icon: <CheckCircle fontSize="small" />,
  },
  [BridgeStatus.Stopped]: {
    label: "Stopped",
    color: "warning",
    icon: <PauseCircle fontSize="small" />,
  },
  [BridgeStatus.Failed]: {
    label: "Failed",
    color: "error",
    icon: <ErrorIcon fontSize="small" />,
  },
};

export const BridgeStatusIcon = ({ status, reason }: BridgeStatusIconProps) => {
  const config = statusConfig[status];

  const chip = (
    <Chip
      icon={config.icon}
      label={config.label}
      size="small"
      color={config.color}
      variant="filled"
      sx={{ fontWeight: 500 }}
    />
  );

  if (reason) {
    return <Tooltip title={reason}>{chip}</Tooltip>;
  }

  return chip;
};
