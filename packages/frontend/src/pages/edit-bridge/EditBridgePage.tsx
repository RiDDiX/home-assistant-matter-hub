import type { BridgeConfig } from "@home-assistant-matter-hub/common";
import Stack from "@mui/material/Stack";
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

export const EditBridgePage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const navigate = useNavigate();

  const { bridgeId } = useParams() as { bridgeId: string };
  const { content: bridge, isLoading } = useBridge(bridgeId);
  const usedPorts = useUsedPorts();
  const updateBridge = useUpdateBridge();

  const bridgeConfig = useMemo<BridgeConfig | undefined>(() => {
    if (isLoading || !bridge) {
      return undefined;
    }
    return {
      name: bridge.name,
      port: bridge.port,
      filter: bridge.filter,
      ...(bridge.countryCode != null && { countryCode: bridge.countryCode }),
      ...(bridge.featureFlags != null && { featureFlags: bridge.featureFlags }),
      ...(bridge.icon != null && { icon: bridge.icon }),
      ...(bridge.priority != null && { priority: bridge.priority }),
      ...(bridge.serialNumberSuffix != null && {
        serialNumberSuffix: bridge.serialNumberSuffix,
      }),
      ...(bridge.uniqueIdSuffix != null && {
        uniqueIdSuffix: bridge.uniqueIdSuffix,
      }),
    };
  }, [isLoading, bridge]);

  const cancelAction = () => {
    navigate(-1);
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

  if (isLoading || !usedPorts) {
    return t("common.loading");
  }
  if (!bridge || !bridgeConfig) {
    return t("notFound.title");
  }

  return (
    <Stack spacing={4}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: bridge.name, to: navigation.bridge(bridgeId) },
          { name: t("common.edit"), to: navigation.editBridge(bridgeId) },
        ]}
      />

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
