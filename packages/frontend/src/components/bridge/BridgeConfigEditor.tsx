import {
  type BridgeConfig,
  type BridgeIconType,
  bridgeConfigSchema,
} from "@home-assistant-matter-hub/common";
import { LibraryBooks, TextFields } from "@mui/icons-material";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Grid from "@mui/material/Grid";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { navigation } from "../../routes.tsx";
import { FormEditor } from "../misc/editors/FormEditor";
import { JsonEditor } from "../misc/editors/JsonEditor";
import type { ValidationError } from "../misc/editors/validation-error.ts";
import { BridgeIconUpload } from "./BridgeIconUpload.tsx";
import { FilterPreview } from "./FilterPreview.tsx";
import { BridgeObjectFieldTemplate } from "./rjsf/BridgeObjectFieldTemplate.tsx";
import { CompactArrayFieldTemplate } from "./rjsf/CompactArrayFieldTemplate.tsx";
import { EntityFilterRuleField } from "./rjsf/EntityFilterRuleField.tsx";
import { FeatureFlagsField } from "./rjsf/FeatureFlagsField.tsx";

enum BridgeEditorMode {
  JSON_EDITOR = "JSON_EDITOR",
  FIELDS_EDITOR = "FIELDS_EDITOR",
}

export interface BridgeConfigEditorProps {
  bridgeId?: string;
  bridge: BridgeConfig;
  usedPorts: Record<number, string>;
  onSave: (config: BridgeConfig) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}

export const BridgeConfigEditor = (props: BridgeConfigEditorProps) => {
  const { t } = useTranslation();
  const [editorMode, setEditorMode] = useState<BridgeEditorMode>(
    BridgeEditorMode.FIELDS_EDITOR,
  );
  const toggleEditor = () => {
    setEditorMode(
      editorMode === BridgeEditorMode.FIELDS_EDITOR
        ? BridgeEditorMode.JSON_EDITOR
        : BridgeEditorMode.FIELDS_EDITOR,
    );
  };

  const [config, setConfig] = useState<object | undefined>(props.bridge);
  const [isValid, setIsValid] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);

  const validatePort = useCallback(
    (value: object | undefined): ValidationError[] => {
      const config = value as Partial<BridgeConfig> | undefined;
      if (!config?.port) {
        return [];
      }
      const usedBy = props.usedPorts[config.port];
      if (usedBy !== undefined && usedBy !== props.bridgeId) {
        return [
          {
            instancePath: "/port",
            message: t("bridge.portInUse", { id: usedBy }),
          },
        ];
      }
      return [];
    },
    [props.bridgeId, props.usedPorts, t],
  );

  const onChange = (data: object | undefined, isValid: boolean) => {
    // Preserve the icon field when FormEditor/JsonEditor updates
    // since icon is managed separately by BridgeIconUpload
    const prevIcon = (prev: object | undefined) => (prev as BridgeConfig)?.icon;
    setConfig((prev) => {
      const icon = prevIcon(prev);
      return icon != null ? { ...data, icon } : { ...data };
    });
    setIsValid(isValid);
  };

  const handleIconChange = useCallback((icon: BridgeIconType | undefined) => {
    setConfig((prev) => {
      if (icon != null) {
        return { ...prev, icon };
      }
      const { icon: _, ...rest } = (prev ?? {}) as BridgeConfig & {
        icon?: BridgeIconType;
      };
      return rest;
    });
  }, []);

  const warnings = useMemo(() => {
    const cfg = config as Partial<BridgeConfig> | undefined;
    const flags = cfg?.featureFlags;
    const result: string[] = [];
    if (flags?.serverMode) {
      result.push("bridge.serverModeWarning");
    }
    if (flags?.serverMode && flags?.vacuumOnOff === false) {
      result.push("bridge.serverModeVacuumOnOffWarning");
    }
    if (!flags?.serverMode && flags?.vacuumOnOff) {
      result.push("bridge.vacuumOnOffBridgeWarning");
    }
    if (flags?.autoForceSync && flags?.autoComposedDevices) {
      result.push("bridge.forceSyncComposedWarning");
    }
    return result;
  }, [config]);

  const saveAction = async () => {
    if (!isValid || saving) {
      return;
    }
    setSaving(true);
    try {
      await props.onSave(config as BridgeConfig);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Alert severity="warning" variant="outlined">
        <Trans
          i18nKey="bridge.configDocsHint"
          components={{
            docs: <Link href={navigation.faq.bridgeConfig} target="_blank" />,
          }}
        />
      </Alert>

      <Alert severity="info" variant="outlined">
        <Trans i18nKey="bridge.communityTip" />
      </Alert>

      {warnings.map((key) => (
        <Alert key={key} severity="warning" variant="outlined">
          {t(key)}
        </Alert>
      ))}

      <Stack spacing={2}>
        <Box display="flex" justifyContent={"flex-end"}>
          <Button
            onClick={() => toggleEditor()}
            title={
              editorMode === BridgeEditorMode.FIELDS_EDITOR
                ? t("bridge.jsonEditor")
                : t("bridge.formEditor")
            }
          >
            {editorMode === BridgeEditorMode.FIELDS_EDITOR ? (
              <TextFields />
            ) : (
              <LibraryBooks />
            )}
          </Button>
        </Box>

        {editorMode === BridgeEditorMode.FIELDS_EDITOR && (
          <FormEditor
            value={config ?? {}}
            onChange={onChange}
            schema={bridgeConfigSchema}
            uiSchema={{
              "ui:submitButtonOptions": { norender: true },
              icon: { "ui:widget": "hidden" },
              featureFlags: { "ui:field": "featureFlags" },
              filter: {
                include: {
                  "ui:options": {
                    ArrayFieldTemplate: CompactArrayFieldTemplate,
                  },
                  items: { "ui:field": "entityFilterRule" },
                },
                exclude: {
                  "ui:options": {
                    ArrayFieldTemplate: CompactArrayFieldTemplate,
                  },
                  items: { "ui:field": "entityFilterRule" },
                },
              },
            }}
            customValidate={validatePort}
            templates={{ ObjectFieldTemplate: BridgeObjectFieldTemplate }}
            fields={{
              featureFlags: FeatureFlagsField,
              entityFilterRule: EntityFilterRuleField,
            }}
          />
        )}

        {editorMode === BridgeEditorMode.JSON_EDITOR && (
          <JsonEditor
            value={config ?? {}}
            onChange={onChange}
            schema={bridgeConfigSchema}
            customValidate={validatePort}
          />
        )}

        {(config as BridgeConfig)?.filter && (
          <FilterPreview filter={(config as BridgeConfig).filter} />
        )}

        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" gutterBottom fontWeight={600}>
              {t("bridge.iconLabel")}
            </Typography>
            <BridgeIconUpload
              bridgeId={props.bridgeId}
              selectedIcon={(config as BridgeConfig)?.icon}
              onIconChange={handleIconChange}
            />
          </CardContent>
        </Card>

        <Grid container>
          <Grid size={{ xs: 6, sm: 4, md: 3 }}>
            <Button fullWidth variant="outlined" onClick={props.onCancel}>
              {t("common.cancel")}
            </Button>
          </Grid>
          <Grid
            size={{ xs: 0, sm: 4, md: 6 }}
            sx={{ display: { xs: "none", sm: "block" } }}
          />
          <Grid size={{ xs: 6, sm: 4, md: 3 }}>
            <Button
              fullWidth
              variant="contained"
              disabled={!isValid || saving}
              onClick={saveAction}
              startIcon={
                saving ? <CircularProgress size={16} color="inherit" /> : null
              }
            >
              {t("common.save")}
            </Button>
          </Grid>
        </Grid>
      </Stack>
    </>
  );
};
