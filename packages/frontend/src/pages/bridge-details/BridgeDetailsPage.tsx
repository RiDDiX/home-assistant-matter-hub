import type {
  BridgeDataWithMetadata,
  EndpointData,
  FailedEntity,
} from "@home-assistant-matter-hub/common";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { updateBridge } from "../../api/bridges.ts";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import { BridgeDetails } from "../../components/bridge/BridgeDetails.tsx";
import { BridgeStatusHint } from "../../components/bridge/BridgeStatusHint.tsx";
import { BridgeStatusIcon } from "../../components/bridge/BridgeStatusIcon.tsx";
import { DiagnosticsCard } from "../../components/bridge/DiagnosticsCard.tsx";
import { EndpointList } from "../../components/endpoints/EndpointList.tsx";
import { EntityMappingSection } from "../../components/entity-mapping/EntityMappingSection.js";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import { useBridge } from "../../hooks/data/bridges.ts";
import { useDevices } from "../../hooks/data/devices.ts";
import { useTimer } from "../../hooks/timer.ts";
import { navigation } from "../../routes.tsx";
import { loadDevices } from "../../state/devices/device-actions.ts";
import { useAppDispatch } from "../../state/hooks.ts";
import { BridgeMoreMenu } from "./BridgeMoreMenu.tsx";

const MemoizedBridgeDetails = memo(BridgeDetails);

const FailedEntitiesAlert = ({
  failedEntities,
}: {
  failedEntities: FailedEntity[];
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!failedEntities || failedEntities.length === 0) {
    return null;
  }

  return (
    <Alert
      severity="warning"
      sx={{ cursor: "pointer" }}
      onClick={() => setExpanded(!expanded)}
    >
      <Typography variant="body2">
        <strong>
          {t("bridge.failedEntitiesCount", { count: failedEntities.length })}
        </strong>{" "}
        {t(expanded ? "bridge.clickToHide" : "bridge.clickToShow")}
      </Typography>
      <Collapse in={expanded}>
        <List dense sx={{ mt: 1 }}>
          {failedEntities.map((entity) => (
            <ListItem key={entity.entityId} sx={{ py: 0 }}>
              <ListItemIcon sx={{ minWidth: 32 }}>
                <WarningIcon color="warning" fontSize="small" />
              </ListItemIcon>
              <ListItemText
                primary={entity.entityId}
                secondary={entity.reason}
                primaryTypographyProps={{
                  variant: "body2",
                  fontWeight: "bold",
                }}
                secondaryTypographyProps={{ variant: "caption" }}
              />
            </ListItem>
          ))}
        </List>
      </Collapse>
    </Alert>
  );
};

export const BridgeDetailsPage = () => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const dispatch = useAppDispatch();

  const { bridgeId } = useParams() as { bridgeId: string };
  const [mappingRefreshKey, setMappingRefreshKey] = useState(0);

  const handleMappingSaved = useCallback(() => {
    setMappingRefreshKey((prev) => prev + 1);
  }, []);

  const timerCallback = useCallback(() => {
    dispatch(loadDevices(bridgeId));
  }, [dispatch, bridgeId]);
  const timer = useTimer(10, timerCallback);

  const {
    content: bridge,
    isLoading: bridgeLoading,
    error: bridgeError,
  } = useBridge(bridgeId);
  const { content: devices, error: devicesError } = useDevices(bridgeId);

  useEffect(() => {
    if (bridgeError) {
      notifications.show({
        message: bridgeError.message ?? t("bridge.loadFailed"),
        severity: "error",
      });
    }
  }, [bridgeError, notifications, t]);

  useEffect(() => {
    if (devicesError?.message) {
      notifications.show({ message: devicesError.message, severity: "error" });
    }
  }, [devicesError, notifications]);

  if (!bridge && bridgeLoading) {
    return t("common.loading");
  }

  if (!bridge) {
    return t("common.notFound");
  }

  return (
    <Stack spacing={4}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: bridge.name, to: navigation.bridge(bridgeId) },
        ]}
      />

      <Box display="flex" justifyContent="space-between">
        <Typography variant="h4">
          {bridge.name} <BridgeStatusIcon status={bridge.status} />
        </Typography>
        <BridgeMoreMenu bridge={bridgeId} />
      </Box>

      <BridgeStatusHint status={bridge.status} reason={bridge.statusReason} />

      {bridge.status === "running" &&
        bridge.commissioning &&
        !bridge.commissioning.isCommissioned &&
        bridge.commissioning.fabrics.length === 0 && (
          <Alert severity="info" icon={<InfoOutlinedIcon />}>
            <AlertTitle>{t("bridge.pairHint")}</AlertTitle>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("bridge.pairDescription")}
            </Typography>
          </Alert>
        )}

      {bridge.failedEntities && bridge.failedEntities.length > 0 && (
        <FailedEntitiesAlert failedEntities={bridge.failedEntities} />
      )}

      <ServerModeRecommendation bridge={bridge} devices={devices} />

      <MemoizedBridgeDetails bridge={bridge} />

      {devices && <DiagnosticsCard devices={devices} />}

      <EntityMappingSection bridgeId={bridgeId} key={mappingRefreshKey} />

      {devices && (
        <Stack spacing={2}>
          <Box display="flex" justifyContent="flex-end" alignItems="center">
            {timer != null && (
              <Tooltip title={t("bridge.refreshHint")}>
                <Typography variant="body2" color="textSecondary">
                  {t("bridge.refreshingStates", { seconds: timer - 1 })}
                </Typography>
              </Tooltip>
            )}
          </Box>

          <EndpointList
            endpoint={devices}
            bridgeId={bridgeId}
            onMappingSaved={handleMappingSaved}
          />
        </Stack>
      )}
    </Stack>
  );
};

function hasVacuumEndpoint(endpoint: EndpointData): boolean {
  if (endpoint.type.name === "RoboticVacuumCleaner") {
    return true;
  }
  return endpoint.parts.some(hasVacuumEndpoint);
}

function countDeviceEndpoints(endpoint: EndpointData): number {
  if (endpoint.type.name === "Aggregator") {
    return endpoint.parts.length;
  }
  let count = 0;
  for (const part of endpoint.parts) {
    count += countDeviceEndpoints(part);
  }
  return count;
}

const ServerModeRecommendation = ({
  bridge,
  devices,
}: {
  bridge: BridgeDataWithMetadata;
  devices: EndpointData | undefined;
}) => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const [enabling, setEnabling] = useState(false);

  const shouldShow = useMemo(() => {
    if (!devices) return false;
    if (bridge.featureFlags?.serverMode) return false;
    if (!hasVacuumEndpoint(devices)) return false;
    const fabrics = bridge.commissioning?.fabrics ?? [];
    if (fabrics.length === 0) return true;
    const appleAlexaVendors = new Set([4937, 4631, 4448]);
    return fabrics.some((f) => appleAlexaVendors.has(f.rootVendorId));
  }, [devices, bridge.featureFlags?.serverMode, bridge.commissioning?.fabrics]);

  const isSingleDevice = useMemo(() => {
    if (!devices) return false;
    return countDeviceEndpoints(devices) === 1;
  }, [devices]);

  const handleEnableServerMode = async () => {
    setEnabling(true);
    try {
      await updateBridge({
        id: bridge.id,
        name: bridge.name,
        port: bridge.port,
        filter: bridge.filter,
        featureFlags: {
          ...bridge.featureFlags,
          serverMode: true,
        },
        icon: bridge.icon,
        priority: bridge.priority,
      });
      notifications.show({
        message: t("bridge.serverModeEnabled"),
        severity: "success",
      });
    } catch (e) {
      notifications.show({
        message: t("bridge.serverModeEnableFailed", {
          error: e instanceof Error ? e.message : String(e),
        }),
        severity: "error",
      });
    } finally {
      setEnabling(false);
    }
  };

  if (!shouldShow) return null;

  return (
    <Alert
      severity="warning"
      icon={<RocketLaunchIcon />}
      action={
        isSingleDevice ? (
          <Button
            color="warning"
            size="small"
            variant="outlined"
            onClick={handleEnableServerMode}
            disabled={enabling}
            startIcon={enabling ? <CircularProgress size={16} /> : undefined}
            sx={{ whiteSpace: "nowrap" }}
          >
            {enabling ? t("bridge.enabling") : t("bridge.enableServerMode")}
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>{t("bridge.serverModeRecommended")}</AlertTitle>
      <Typography variant="body2">
        {t("bridge.serverModeDescription")}
      </Typography>
      {!isSingleDevice && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {t("bridge.serverModeSingleDeviceNote")}
        </Typography>
      )}
    </Alert>
  );
};
