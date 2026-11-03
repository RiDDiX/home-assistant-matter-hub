import type { BridgeConfig } from "@home-assistant-matter-hub/common";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import { BridgeConfigEditor } from "../../components/bridge/BridgeConfigEditor.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import {
  useBridge,
  useUpdateBridge,
  useUsedPorts,
} from "../../hooks/data/bridges.ts";
import { navigation } from "../../routes.tsx";
import { NotFoundPage } from "../NotFoundPage.tsx";
import { bridgeToConfig } from "./bridge-to-config.ts";

export const EditBridgePage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const navigate = useNavigate();

  const { bridgeId } = useParams() as { bridgeId: string };
  const { content: bridge, isLoading } = useBridge(bridgeId);
  const usedPorts = useUsedPorts();
  const updateBridge = useUpdateBridge();

  const bridgeConfig = useMemo<BridgeConfig | undefined>(
    () => (bridge ? bridgeToConfig(bridge) : undefined),
    [bridge],
  );

  const cancelAction = () => {
    navigate(navigation.bridge(bridgeId));
  };

  const saveAction = async (config: BridgeConfig) => {
    await updateBridge({ ...config, id: bridgeId })
      .then(() =>
        notifications.show({
          message: t("bridge.updateSuccess"),
          severity: "success",
        }),
      )
      .then(() => cancelAction())
      .catch((err: Error) =>
        notifications.show({ message: err.message, severity: "error" }),
      );
  };

  // a background reload must not remount the editor and drop unsaved edits
  if (!usedPorts || (!bridge && isLoading)) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }
  if (!bridge || !bridgeConfig) {
    return <NotFoundPage />;
  }

  return (
    <Stack spacing={4}>
      <Stack spacing={1}>
        <Breadcrumbs
          items={[
            { name: t("nav.bridges"), to: navigation.bridges },
            { name: bridge.name, to: navigation.bridge(bridgeId) },
            { name: t("common.edit"), to: navigation.editBridge(bridgeId) },
          ]}
        />
        <Typography variant="h5" component="h1">
          {bridge.name}
        </Typography>
      </Stack>

      <BridgeConfigEditor
        bridgeId={bridgeId}
        bridge={bridgeConfig}
        usedPorts={usedPorts}
        onSave={saveAction}
        onCancel={cancelAction}
      />
    </Stack>
  );
};
