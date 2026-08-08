import {
  type BridgeConfig,
  type BridgeTemplate,
  bridgeTemplates,
} from "@home-assistant-matter-hub/common";
import Alert from "@mui/material/Alert";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
    navigate(-1);
  };

  const saveAction = async (config: BridgeConfig) => {
    await createBridge({ ...config })
      .then(() =>
        notifications.show({
          message: t("bridge.saveSuccess"),
          severity: "success",
        }),
      )
      .then(() => cancelAction())
      .catch((err: Error) =>
        notifications.show({ message: err.message, severity: "error" }),
      );
  };

  if (!bridgeConfig || !usedPorts) {
    return t("common.loading");
  }

  return (
    <Stack spacing={4}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: t("common.create"), to: navigation.createBridge },
        ]}
      />

      {showReuseBridgeHint && (
        <Alert severity="info" variant="outlined">
          <Typography>
            Did you know that you can connect the same bridge with multiple
            assistants?{" "}
            <Link href={navigation.faq.multiFabric} target="_blank">
              Learn more.
            </Link>
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
