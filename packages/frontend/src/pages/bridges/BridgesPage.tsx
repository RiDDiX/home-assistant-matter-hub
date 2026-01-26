import { Add, AutoFixHigh, Download, Upload } from "@mui/icons-material";
import Backdrop from "@mui/material/Backdrop";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { exportAllBridges } from "../../api/bridge-export.js";
import { BridgeImportDialog } from "../../components/bridge/BridgeImportDialog.js";
import { BridgeList } from "../../components/bridge/BridgeList";
import { BridgeWizard } from "../../components/bridge/BridgeWizard.js";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import { useBridges } from "../../hooks/data/bridges";
import { navigation } from "../../routes.tsx";
import { loadBridges } from "../../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../../state/hooks.ts";

export const BridgesPage = () => {
  const notifications = useNotifications();

  const dispatch = useAppDispatch();
  const { content: bridges, isLoading, error: bridgeError } = useBridges();
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = useCallback(async () => {
    try {
      await exportAllBridges();
    } catch (e) {
      notifications.show({
        message: e instanceof Error ? e.message : "Export failed",
        severity: "error",
      });
    }
  }, [notifications]);

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

  useEffect(() => {
    if (bridgeError) {
      notifications.show({
        message: bridgeError.message ?? "Could not load bridges",
        severity: "error",
      });
    }
  }, [bridgeError, notifications]);

  return (
    <>
      <Backdrop
        sx={(theme) => ({ zIndex: theme.zIndex.drawer + 1 })}
        open={isLoading}
      >
        {isLoading && <CircularProgress color="inherit" />}
      </Backdrop>

      <Stack spacing={4}>
        {bridges && (
          <>
            <Box
              display="flex"
              justifyContent="end"
              gap={1}
              paddingTop={{ xs: 1, sm: 0 }}
            >
              <Button
                onClick={handleImportClick}
                startIcon={<Upload />}
                variant="outlined"
              >
                Import
              </Button>
              <Button
                onClick={handleExport}
                startIcon={<Download />}
                variant="outlined"
                disabled={bridges.length === 0}
              >
                Export All
              </Button>
              <Button
                onClick={() => setWizardOpen(true)}
                startIcon={<AutoFixHigh />}
                variant="outlined"
              >
                Wizard
              </Button>
              <Button
                component={Link}
                to={navigation.createBridge}
                endIcon={<Add />}
                variant="outlined"
              >
                Create new bridge
              </Button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept=".json"
                style={{ display: "none" }}
              />
            </Box>

            <BridgeList bridges={bridges} />
          </>
        )}
      </Stack>

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
