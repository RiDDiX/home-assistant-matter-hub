import {
  type BridgeConfig,
  type BridgeTemplate,
  bridgeTemplates,
} from "@home-assistant-matter-hub/common";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import { BridgeConfigEditor } from "../../components/bridge/BridgeConfigEditor.tsx";
import { BridgeTemplateSelector } from "../../components/bridge/BridgeTemplateSelector.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import {
  useBridges,
  useCreateBridge,
  useUsedPorts,
} from "../../hooks/data/bridges.ts";
import { navigation } from "../../routes.tsx";

const defaultConfig: Omit<BridgeConfig, "port"> = {
  name: "",
  featureFlags: {},
  filter: {
    include: [],
    exclude: [],
  },
};

function nextFreePort(usedPorts: Record<number, string>) {
  let port = 5540;
  while (usedPorts[port]) {
    port++;
  }
  return port;
}

export const CreateBridgePage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const navigate = useNavigate();
  const [selectedTemplateId, setSelectedTemplateId] = useState<
    string | undefined
  >();

  const showReuseBridgeHint = !!useBridges().content?.length;
  const usedPorts = useUsedPorts();

  const handleTemplateSelect = useCallback(
    (template: BridgeTemplate | null) => {
      setSelectedTemplateId(template?.id);
    },
    [],
  );

  const bridgeConfig: BridgeConfig | undefined = useMemo(() => {
    if (!usedPorts) return undefined;
    const port = nextFreePort(usedPorts);
    if (selectedTemplateId) {
      const template = bridgeTemplates.find((t) => t.id === selectedTemplateId);
      if (template) {
        return {
          name: template.name,
          port,
          filter: { ...template.filter },
          featureFlags: { ...template.featureFlags },
          icon: template.icon,
        };
      }
    }
    return { ...defaultConfig, port };
  }, [usedPorts, selectedTemplateId]);

  const createBridge = useCreateBridge();

  const cancelAction = () => {
    navigate(navigation.bridges);
  };

  const saveAction = async (config: BridgeConfig) => {
    await createBridge({ ...config })
      .then((bridge) => {
        notifications.show({
          message: t("bridge.saveSuccess"),
          severity: "success",
        });
        navigate(navigation.bridge(bridge.id));
      })
      .catch((err: Error) =>
        notifications.show({ message: err.message, severity: "error" }),
      );
  };

  if (!bridgeConfig || !usedPorts) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={4}>
      <Stack spacing={1}>
        <Breadcrumbs
          items={[
            { name: t("nav.bridges"), to: navigation.bridges },
            { name: t("common.create"), to: navigation.createBridge },
          ]}
        />
        <Typography variant="h5" component="h1">
          {t("dashboard.createBridge")}
        </Typography>
      </Stack>

      {showReuseBridgeHint && (
        <Alert severity="info" variant="outlined">
          <Typography>
            <Trans
              i18nKey="bridge.multiFabricHint"
              components={{
                more: (
                  <Link href={navigation.faq.multiFabric} target="_blank" />
                ),
              }}
            />
          </Typography>
        </Alert>
      )}

      <BridgeTemplateSelector
        selectedTemplate={selectedTemplateId}
        onSelect={handleTemplateSelect}
      />

      <BridgeConfigEditor
        key={selectedTemplateId ?? "custom"}
        bridge={bridgeConfig}
        usedPorts={usedPorts}
        onSave={saveAction}
        onCancel={cancelAction}
      />
    </Stack>
  );
};
