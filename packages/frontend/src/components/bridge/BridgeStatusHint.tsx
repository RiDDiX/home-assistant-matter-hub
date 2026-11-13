import { BridgeStatus } from "@home-assistant-matter-hub/common";
import type { AlertColor } from "@mui/material/Alert";
import Alert from "@mui/material/Alert";
import { useTranslation } from "react-i18next";
import { bridgeStatusMessage } from "./bridge-status-message.ts";

export interface BridgeStatusHintProps {
  status: BridgeStatus;
  reason?: string;
}

const severity: Record<BridgeStatus, AlertColor> = {
  [BridgeStatus.Failed]: "error",
  [BridgeStatus.Stopped]: "warning",
  [BridgeStatus.Starting]: "info",
  [BridgeStatus.Running]: "success",
};

export const BridgeStatusHint = ({ status, reason }: BridgeStatusHintProps) => {
  const { t } = useTranslation();
  if (!reason) {
    return;
  }
  return (
    <Alert severity={severity[status]} variant="outlined">
      {bridgeStatusMessage(reason, t)}
    </Alert>
  );
};
