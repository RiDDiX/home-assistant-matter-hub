import type { FailedEntity } from "@home-assistant-matter-hub/common";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { memo, useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import { BridgeDetails } from "../../components/bridge/BridgeDetails.tsx";
import { BridgeStatusHint } from "../../components/bridge/BridgeStatusHint.tsx";
import { BridgeStatusIcon } from "../../components/bridge/BridgeStatusIcon.tsx";
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
const MemoizedEndpointList = memo(EndpointList);

const FailedEntitiesAlert = ({
  failedEntities,
}: {
  failedEntities: FailedEntity[];
}) => {
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
          {failedEntities.length} entity/entities could not be loaded.
        </strong>{" "}
        Click to {expanded ? "hide" : "show"} details.
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
  const notifications = useNotifications();
  const dispatch = useAppDispatch();

  const { bridgeId } = useParams() as { bridgeId: string };

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
        message: bridgeError.message ?? "Failed to load Bridge details",
        severity: "error",
      });
    }
  }, [bridgeError, notifications]);

  useEffect(() => {
    if (devicesError?.message) {
      notifications.show({ message: devicesError.message, severity: "error" });
    }
  }, [devicesError, notifications]);

  if (!bridge && bridgeLoading) {
    return "Loading";
  }

  if (!bridge) {
    return "Not found";
  }

  return (
    <Stack spacing={4}>
      <Breadcrumbs
        items={[
          { name: "Bridges", to: navigation.bridges },
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

      {bridge.failedEntities && bridge.failedEntities.length > 0 && (
        <FailedEntitiesAlert failedEntities={bridge.failedEntities} />
      )}

      <MemoizedBridgeDetails bridge={bridge} />

      <EntityMappingSection bridgeId={bridgeId} />

      {devices && (
        <Stack spacing={2}>
          <Box display="flex" justifyContent="flex-end" alignItems="center">
            {timer != null && (
              <Tooltip title="New devices and changes on labels are discovered every 30 seconds.">
                <Typography variant="body2" color="textSecondary">
                  Refreshing states in {timer - 1} seconds...
                </Typography>
              </Tooltip>
            )}
          </Box>

          <MemoizedEndpointList endpoint={devices} />
        </Stack>
      )}
    </Stack>
  );
};
