import CleaningServicesIcon from "@mui/icons-material/CleaningServices";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import MoreVert from "@mui/icons-material/MoreVert";
import ResetIcon from "@mui/icons-material/RotateLeft";
import SyncIcon from "@mui/icons-material/Sync";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link as RouterLink, useNavigate } from "react-router";
import { ConfirmDialog } from "../../components/misc/ConfirmDialog.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import {
  useDeleteBridge,
  useForceSyncBridge,
  useResetBridge,
} from "../../hooks/data/bridges.ts";
import { navigation } from "../../routes.tsx";
import { OrphanCleanupDialog } from "./OrphanCleanupDialog.tsx";

export interface BridgeMoreMenuProps {
  bridge: string;
}

export const BridgeMoreMenu = ({ bridge }: BridgeMoreMenuProps) => {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const open = Boolean(anchorEl);

  const navigate = useNavigate();
  const notification = useNotifications();
  const { t } = useTranslation();

  const factoryReset = useResetBridge();
  const deleteBridge = useDeleteBridge();
  const forceSync = useForceSyncBridge();

  const [confirmAction, setConfirmAction] = React.useState<
    "delete" | "reset" | null
  >(null);
  const [orphanDialogOpen, setOrphanDialogOpen] = React.useState(false);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) =>
    setAnchorEl(event.currentTarget);
  const handleClose = () => setAnchorEl(null);

  const handleForceSync = async () => {
    handleClose();
    await forceSync(bridge)
      .then((result) =>
        notification.show({
          message: `Synced ${result.syncedCount} devices to controllers`,
          severity: "success",
        }),
      )
      .catch((reason) =>
        notification.show({
          message: `Failed to sync: ${reason?.message ?? JSON.stringify(reason)}`,
          severity: "error",
        }),
      );
  };

  const handleFactoryReset = async () => {
    setConfirmAction(null);
    await factoryReset(bridge)
      .then(() =>
        notification.show({
          message: t("bridge.resetSuccess"),
          severity: "success",
        }),
      )
      .catch((reason) =>
        notification.show({
          message: `Failed to reset bridge: ${reason?.message ?? JSON.stringify(reason)}`,
          severity: "error",
        }),
      );
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
          message: `Failed to delete bridge: ${reason?.message ?? JSON.stringify(reason)}`,
          severity: "error",
        }),
      );
  };

  return (
    <>
      <IconButton onClick={handleOpen}>
        <MoreVert />
      </IconButton>
      <Menu open={open} onClose={handleClose} anchorEl={anchorEl}>
        <MenuItem component={RouterLink} to={navigation.editBridge(bridge)}>
          <ListItemIcon>
            <EditIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("common.edit")}</ListItemText>
        </MenuItem>
        <Divider />
        <MenuItem onClick={handleForceSync}>
          <ListItemIcon>
            <SyncIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("bridge.forceSync")}</ListItemText>
        </MenuItem>
        <MenuItem
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
