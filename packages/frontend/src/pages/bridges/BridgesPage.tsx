import {
  Add,
  AutoFixHigh,
  Download,
  Hub,
  Map as MapIcon,
  PlayArrow,
  RestartAlt,
  Stop,
  Upload,
} from "@mui/icons-material";
import Alert from "@mui/material/Alert";
import Backdrop from "@mui/material/Backdrop";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { exportAllBridges } from "../../api/bridge-export.js";
import {
  restartAllBridges,
  startAllBridges,
  stopAllBridges,
} from "../../api/bridges.js";
import { BridgeImportDialog } from "../../components/bridge/BridgeImportDialog.js";
import { BridgeList } from "../../components/bridge/BridgeList";
import { BridgeWizard } from "../../components/bridge/BridgeWizard.js";
import { ConfirmDialog } from "../../components/misc/ConfirmDialog.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import { useBridges } from "../../hooks/data/bridges";
import { navigation } from "../../routes.tsx";
import { loadBridges } from "../../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../../state/hooks.ts";

export const BridgesPage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();

  const dispatch = useAppDispatch();
  const { content: bridges, isLoading, error: bridgeError } = useBridges();
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [pendingBulk, setPendingBulk] = useState<"stop" | "restart" | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = useCallback(async () => {
    try {
      await exportAllBridges();
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : t("bridge.exportFailed"),
        severity: "error",
      });
    }
  }, [notifications, t]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setImportFile(file);
        setImportDialogOpen(true);
      }
      e.target.value = "";
    },
    [],
  );

  const handleImportClose = useCallback(() => {
    setImportDialogOpen(false);
    setImportFile(null);
  }, []);

  const handleImported = useCallback(() => {
    dispatch(loadBridges());
  }, [dispatch]);

  const handleBulkAction = useCallback(
    async (action: "start" | "stop" | "restart") => {
      setBulkLoading(true);
      try {
        const labels = {
          start: t("bridge.actionStarted"),
          stop: t("bridge.actionStopped"),
          restart: t("bridge.actionRestarted"),
        };
        const fns = {
          start: startAllBridges,
          stop: stopAllBridges,
          restart: restartAllBridges,
        };
        const result = await fns[action]();
        notifications.show({
          message: t("bridge.actionResult", {
            label: labels[action],
            count: result.count,
          }),
          severity: "success",
        });
        dispatch(loadBridges());
      } catch (e) {
        notifications.show({
          message:
            e instanceof Error
              ? e.message
              : t("bridge.actionFailed", { action }),
          severity: "error",
        });
      } finally {
        setBulkLoading(false);
      }
    },
    [notifications, dispatch, t],
  );

  useEffect(() => {
    if (bridgeError) {
      notifications.show({
        message: bridgeError.message ?? t("bridge.couldNotLoad"),
        severity: "error",
      });
    }
  }, [bridgeError, notifications, t]);

  return (
    <>
      <Backdrop
        sx={(theme) => ({ zIndex: theme.zIndex.drawer + 1 })}
        open={isLoading || bulkLoading}
      >
        {(isLoading || bulkLoading) && <CircularProgress color="inherit" />}
      </Backdrop>

      <Stack spacing={4}>
        <Stack spacing={2}>
          <Box display="flex" alignItems="center" gap={2}>
            <Hub color="primary" fontSize="large" />
            <Typography variant="h5" component="h1" flexGrow={1}>
              {t("nav.bridges")}
            </Typography>
            <Button
              component={Link}
              to={navigation.createBridge}
              startIcon={<Add />}
              variant="contained"
            >
              {t("dashboard.createBridge")}
            </Button>
          </Box>
          {!bridges && bridgeError && (
            <Alert severity="error">
              {bridgeError.message ?? t("bridge.couldNotLoad")}
            </Alert>
          )}
        </Stack>
        {bridges && (
          <>
            <Stack spacing={2}>
              <Box display="flex" alignItems="center" flexWrap="wrap" gap={1}>
                {bridges.length >= 1 && (
                  <>
                    <Button
                      onClick={() => handleBulkAction("start")}
                      startIcon={<PlayArrow />}
                      variant="outlined"
                      size="small"
                      color="success"
                      disabled={bulkLoading}
                    >
                      {t("common.startAll")}
                    </Button>
                    <Button
                      onClick={() => setPendingBulk("stop")}
                      startIcon={<Stop />}
                      variant="outlined"
                      size="small"
                      color="error"
                      disabled={bulkLoading}
                    >
                      {t("common.stopAll")}
                    </Button>
                    <Button
                      onClick={() => setPendingBulk("restart")}
                      startIcon={<RestartAlt />}
                      variant="outlined"
                      size="small"
                      color="warning"
                      disabled={bulkLoading}
                    >
                      {t("common.restartAll")}
                    </Button>
                    <Divider
                      orientation="vertical"
                      flexItem
                      sx={{ display: { xs: "none", sm: "block" } }}
                    />
                  </>
                )}
                <Button
                  onClick={handleImportClick}
                  startIcon={<Download />}
                  variant="outlined"
                  size="small"
                >
                  {t("common.import")}
                </Button>
                <Button
                  onClick={handleExport}
                  startIcon={<Upload />}
                  variant="outlined"
                  size="small"
                  disabled={bridges.length === 0}
                >
                  {t("common.exportAll")}
                </Button>
                <Button
                  component={Link}
                  to={navigation.areaSetup}
                  startIcon={<MapIcon />}
                  variant="outlined"
                  size="small"
                >
                  {t("areaSetup.title")}
                </Button>
                <Button
                  onClick={() => setWizardOpen(true)}
                  startIcon={<AutoFixHigh />}
                  variant="outlined"
                  size="small"
                >
                  {t("bridgeWizard.title")}
                </Button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".json"
                  style={{ display: "none" }}
                />
              </Box>
            </Stack>

            {bridges.length === 0 ? (
              <Alert severity="info">{t("dashboard.noBridgesHint")}</Alert>
            ) : (
              <BridgeList bridges={bridges} />
            )}
          </>
        )}
      </Stack>

      <ConfirmDialog
        open={pendingBulk === "stop"}
        title={t("bridge.confirmStopAllTitle")}
        message={t("bridge.confirmStopAllMessage")}
        confirmLabel={t("common.stopAll")}
        cancelLabel={t("common.cancel")}
        confirmColor="error"
        onConfirm={() => {
          setPendingBulk(null);
          handleBulkAction("stop");
        }}
        onCancel={() => setPendingBulk(null)}
      />
      <ConfirmDialog
        open={pendingBulk === "restart"}
        title={t("bridge.confirmRestartAllTitle")}
        message={t("bridge.confirmRestartAllMessage")}
        confirmLabel={t("common.restartAll")}
        cancelLabel={t("common.cancel")}
        confirmColor="warning"
        onConfirm={() => {
          setPendingBulk(null);
          handleBulkAction("restart");
        }}
        onCancel={() => setPendingBulk(null)}
      />

      <BridgeImportDialog
        open={importDialogOpen}
        file={importFile}
        onClose={handleImportClose}
        onImported={handleImported}
      />

      <BridgeWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={() => dispatch(loadBridges())}
      />
    </>
  );
};
