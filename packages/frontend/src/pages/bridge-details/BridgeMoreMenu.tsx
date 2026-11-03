import CleaningServicesIcon from "@mui/icons-material/CleaningServices";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import MoreVert from "@mui/icons-material/MoreVert";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import ResetIcon from "@mui/icons-material/RotateLeft";
import StopIcon from "@mui/icons-material/Stop";
import SyncIcon from "@mui/icons-material/Sync";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router";
import { exportBridge } from "../../api/bridge-export.ts";
import { startStopBridge } from "../../api/bridges.ts";
import { ConfirmDialog } from "../../components/misc/ConfirmDialog.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import {
  useCloneBridge,
  useDeleteBridge,
  useForceSyncBridge,
  useResetBridge,
} from "../../hooks/data/bridges.ts";
import { navigation } from "../../routes.tsx";
import { OrphanCleanupDialog } from "./OrphanCleanupDialog.tsx";

export interface BridgeMoreMenuProps {
  bridge: string;
  // factory reset only works on a running bridge
  running?: boolean;
}

export const BridgeMoreMenu = ({
  bridge,
  running = true,
}: BridgeMoreMenuProps) => {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const navigate = useNavigate();
  const notification = useNotifications();
  const { t } = useTranslation();

  const factoryReset = useResetBridge();
  const deleteBridge = useDeleteBridge();
  const forceSync = useForceSyncBridge();
  const cloneBridge = useCloneBridge();

  const [confirmAction, setConfirmAction] = React.useState<
    "delete" | "reset" | null
  >(null);
  const [orphanDialogOpen, setOrphanDialogOpen] = React.useState(false);
  // sync, reset, start and stop can take seconds on a real install
  const [busy, setBusy] = React.useState(false);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget);
  const handleClose = () => setAnchorEl(null);

  const errorText = (reason: unknown) =>
    reason instanceof Error ? reason.message : String(reason);

  const handleStartStop = async () => {
    handleClose();
    setBusy(true);
    await startStopBridge(bridge, running ? "stop" : "start")
      .catch((reason) =>
        notification.show({ message: errorText(reason), severity: "error" }),
      )
      .finally(() => setBusy(false));
  };

  const handleForceSync = async () => {
    handleClose();
    setBusy(true);
    await forceSync(bridge)
      .then((result) =>
        notification.show({
          message: t("bridgeUi.syncSuccess", { count: result.syncedCount }),
          severity: "success",
        }),
      )
      .catch((reason) =>
        notification.show({
          message: t("bridgeUi.syncFailed", { error: errorText(reason) }),
          severity: "error",
        }),
      )
      .finally(() => setBusy(false));
  };

  const handleClone = async () => {
    handleClose();
    await cloneBridge(bridge)
      .then((clone) => {
        notification.show({
          message: t("bridge.cloneSuccess", { name: clone.name }),
          severity: "success",
        });
        navigate(navigation.bridge(clone.id));
      })
      .catch((reason) =>
        notification.show({
          message: t("bridge.cloneFailed", { error: errorText(reason) }),
          severity: "error",
        }),
      );
  };

  const handleExport = async () => {
    handleClose();
    await exportBridge(bridge).catch((reason) =>
      notification.show({
        message:
          reason instanceof Error ? reason.message : t("bridge.exportFailed"),
        severity: "error",
      }),
    );
  };

  const handleFactoryReset = async () => {
    setConfirmAction(null);
    setBusy(true);
    await factoryReset(bridge)
      .then(() =>
        notification.show({
          message: t("bridge.resetSuccess"),
          severity: "success",
        }),
      )
      .catch((reason) =>
        notification.show({
          message: t("bridge.resetFailed", { error: errorText(reason) }),
          severity: "error",
        }),
      )
      .finally(() => setBusy(false));
  };
  const handleDelete = async () => {
    setConfirmAction(null);
    await deleteBridge(bridge)
      .then(() =>
        notification.show({
          message: t("bridge.deleteSuccess"),
          severity: "success",
        }),
      )
      .then(() => navigate(navigation.bridges))
      .catch((reason) =>
        notification.show({
          message: t("bridge.deleteFailed", { error: errorText(reason) }),
          severity: "error",
        }),
      );
  };

  return (
    <>
      <IconButton
        onClick={handleOpen}
        disabled={busy}
        aria-busy={busy}
        aria-label={t("common.actions")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "bridge-more-menu" : undefined}
      >
        {busy ? <CircularProgress size={24} /> : <MoreVert />}
      </IconButton>
      <Menu
        id="bridge-more-menu"
        open={open}
        onClose={handleClose}
        anchorEl={anchorEl}
      >
        <MenuItem component={RouterLink} to={navigation.editBridge(bridge)}>
          <ListItemIcon>
            <EditIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("common.edit")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleClone}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("bridge.clone")}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleExport}>
          <ListItemIcon>
            <FileUploadIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("common.export")}</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={handleStartStop}>
          <ListItemIcon>
            {running ? (
              <StopIcon fontSize="small" />
            ) : (
              <PlayArrowIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>
            {running ? t("bridge.stop") : t("bridge.start")}
          </ListItemText>
        </MenuItem>
        <MenuItem onClick={handleForceSync}>
          <ListItemIcon>
            <SyncIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("bridge.forceSync")}</ListItemText>
        </MenuItem>
        <MenuItem
          disabled={!running}
          onClick={() => {
            handleClose();
            setConfirmAction("reset");
          }}
        >
          <ListItemIcon>
            <ResetIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("bridge.factoryReset")}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            handleClose();
            setOrphanDialogOpen(true);
          }}
        >
          <ListItemIcon>
            <CleaningServicesIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("bridge.orphanMenu")}</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            handleClose();
            setConfirmAction("delete");
          }}
        >
          <ListItemIcon>
            <DeleteIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("common.delete")}</ListItemText>
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirmAction === "reset"}
        title={t("bridge.confirmResetTitle")}
        message={t("bridge.confirmResetMessage")}
        confirmLabel={t("common.reset")}
        confirmColor="warning"
        onConfirm={handleFactoryReset}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction === "delete"}
        title={t("bridge.confirmDeleteTitle")}
        message={t("bridge.confirmDeleteMessage")}
        confirmLabel={t("common.delete")}
        confirmColor="error"
        onConfirm={handleDelete}
        onCancel={() => setConfirmAction(null)}
      />
      <OrphanCleanupDialog
        open={orphanDialogOpen}
        bridgeId={bridge}
        onClose={() => setOrphanDialogOpen(false)}
      />
    </>
  );
};
