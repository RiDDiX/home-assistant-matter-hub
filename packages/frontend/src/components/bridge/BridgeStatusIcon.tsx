import { BridgeStatus } from "@home-assistant-matter-hub/common";
import CheckCircle from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import PauseCircle from "@mui/icons-material/PauseCircle";
import Sync from "@mui/icons-material/Sync";
import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { useTranslation } from "react-i18next";
import { bridgeStatusMessage } from "./bridge-status-message.ts";

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
    label: "common.starting",
    color: "info",
    icon: <Sync fontSize="small" />,
  },
  [BridgeStatus.Running]: {
    label: "common.running",
    color: "success",
    icon: <CheckCircle fontSize="small" />,
  },
  [BridgeStatus.Stopped]: {
    label: "common.stopped",
    color: "warning",
    icon: <PauseCircle fontSize="small" />,
  },
  [BridgeStatus.Failed]: {
    label: "common.failed",
    color: "error",
    icon: <ErrorIcon fontSize="small" />,
  },
};

export const BridgeStatusIcon = ({ status, reason }: BridgeStatusIconProps) => {
  const { t } = useTranslation();
  const config = statusConfig[status];

  const chip = (
    <Chip
      icon={config.icon}
      label={t(config.label)}
      size="small"
      color={config.color}
      variant="filled"
      sx={{ fontWeight: 500 }}
    />
  );

  if (reason) {
    return <Tooltip title={bridgeStatusMessage(reason, t)}>{chip}</Tooltip>;
  }

  return chip;
};
