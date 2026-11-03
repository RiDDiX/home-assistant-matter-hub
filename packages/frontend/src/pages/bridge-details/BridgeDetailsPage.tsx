import {
  type BridgeDataWithMetadata,
  BridgeStatus,
  classifyController,
  type EndpointData,
} from "@home-assistant-matter-hub/common";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
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
import { bridgeToConfig } from "../edit-bridge/bridge-to-config.ts";
import { NotFoundPage } from "../NotFoundPage.tsx";
import { BridgeMoreMenu } from "./BridgeMoreMenu.tsx";

const MemoizedBridgeDetails = memo(BridgeDetails);

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
    isInitialized: bridgeInitialized,
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

  // an unknown bridge id shows NotFoundPage, its devices 404 is no news
  const hasBridge = bridge != null;
  useEffect(() => {
    if (hasBridge && devicesError?.message) {
      notifications.show({ message: devicesError.message, severity: "error" });
    }
  }, [hasBridge, devicesError, notifications]);

  if (!bridge && (!bridgeInitialized || bridgeLoading)) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  if (!bridge) {
    return <NotFoundPage />;
  }

  return (
    <Stack spacing={4}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: bridge.name, to: navigation.bridge(bridgeId) },
        ]}
      />

      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Typography variant="h5" component="h1">
          {bridge.name} <BridgeStatusIcon status={bridge.status} />
        </Typography>
        <BridgeMoreMenu
          bridge={bridgeId}
          running={bridge.status === BridgeStatus.Running}
        />
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

      <MemoizedBridgeDetails bridge={bridge} />

      <ServerModeRecommendation bridge={bridge} devices={devices} />

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
    return fabrics.some((f) => {
      const controller = classifyController(f.rootVendorId);
      return controller === "apple" || controller === "alexa";
    });
  }, [devices, bridge.featureFlags?.serverMode, bridge.commissioning?.fabrics]);

  const isSingleDevice = useMemo(() => {
    if (!devices) return false;
    return countDeviceEndpoints(devices) === 1;
  }, [devices]);

  const handleEnableServerMode = async () => {
    setEnabling(true);
    try {
      // PUT replaces the whole config, so send every stored field
      await updateBridge({
        ...bridgeToConfig(bridge),
        id: bridge.id,
        featureFlags: { ...bridge.featureFlags, serverMode: true },
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
