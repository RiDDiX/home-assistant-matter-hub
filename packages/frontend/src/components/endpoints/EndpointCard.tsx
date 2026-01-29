import type { EndpointData } from "@home-assistant-matter-hub/common";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";
import { getEndpointName } from "./EndpointName";

interface BasicInfo {
  reachable?: boolean;
  nodeLabel?: string;
  vendorName?: string;
  productName?: string;
}

interface OnOffState {
  onOff?: boolean;
}

interface ThermostatState {
  localTemperature?: number;
  systemMode?: number;
  occupiedHeatingSetpoint?: number;
  occupiedCoolingSetpoint?: number;
}

interface LevelControlState {
  currentLevel?: number;
}

const getDeviceIcon = (deviceType: string): string => {
  const type = deviceType.toLowerCase();
  if (type.includes("light")) return "💡";
  if (type.includes("switch") || type.includes("plugin")) return "🔌";
  if (type.includes("lock")) return "🔒";
  if (type.includes("thermostat")) return "🌡️";
  if (type.includes("temperature")) return "🌡️";
  if (type.includes("humidity")) return "💧";
  if (type.includes("pressure")) return "📊";
  if (type.includes("sensor")) return "📊";
  if (type.includes("fan")) return "🌀";
  if (type.includes("cover") || type.includes("window")) return "🪟";
  if (type.includes("contact")) return "🚪";
  if (type.includes("occupancy")) return "👤";
  if (type.includes("smoke") || type.includes("alarm")) return "🚨";
  if (type.includes("water")) return "💧";
  if (type.includes("air")) return "🌬️";
  return "📱";
};

const getDeviceColor = (deviceType: string): string => {
  const type = deviceType.toLowerCase();
  if (type.includes("light")) return "#FFD700";
  if (type.includes("switch") || type.includes("plugin")) return "#4CAF50";
  if (type.includes("lock")) return "#2196F3";
  if (type.includes("thermostat")) return "#FF5722";
  if (type.includes("temperature")) return "#FF5722";
  if (type.includes("humidity")) return "#03A9F4";
  if (type.includes("sensor")) return "#9C27B0";
  if (type.includes("fan")) return "#00BCD4";
  if (type.includes("cover") || type.includes("window")) return "#795548";
  if (type.includes("contact")) return "#607D8B";
  if (type.includes("occupancy")) return "#E91E63";
  return "#757575";
};

export interface EndpointCardProps {
  endpoint: EndpointData;
  bridgeName?: string;
  onClick?: () => void;
}

export const EndpointCard = ({
  endpoint,
  bridgeName,
  onClick,
}: EndpointCardProps) => {
  const name = getEndpointName(endpoint.state) ?? endpoint.id.local;
  const deviceType = endpoint.type.name;

  const basicInfo = useMemo(() => {
    const state = endpoint.state as {
      bridgedDeviceBasicInformation?: BasicInfo;
    };
    return state.bridgedDeviceBasicInformation;
  }, [endpoint.state]);

  const isReachable = basicInfo?.reachable ?? true;

  const clusters = useMemo(() => {
    return Object.keys(endpoint.state).filter(
      (key) =>
        ![
          "homeAssistantEntity",
          "bridgedDeviceBasicInformation",
          "identify",
        ].includes(key),
    );
  }, [endpoint.state]);

  const onOffState = useMemo(() => {
    const state = endpoint.state as { onOff?: OnOffState };
    return state.onOff;
  }, [endpoint.state]);

  const levelState = useMemo(() => {
    const state = endpoint.state as { levelControl?: LevelControlState };
    return state.levelControl;
  }, [endpoint.state]);

  const thermostatState = useMemo(() => {
    const state = endpoint.state as { thermostat?: ThermostatState };
    return state.thermostat;
  }, [endpoint.state]);

  const stateDisplay = useMemo(() => {
    if (thermostatState?.localTemperature !== undefined) {
      const temp = thermostatState.localTemperature / 100;
      return `${temp.toFixed(1)}°C`;
    }
    if (levelState?.currentLevel !== undefined) {
      const percent = Math.round((levelState.currentLevel / 254) * 100);
      return `${percent}%`;
    }
    if (onOffState?.onOff !== undefined) {
      return onOffState.onOff ? "On" : "Off";
    }
    return null;
  }, [onOffState, levelState, thermostatState]);

  return (
    <Card
      onClick={onClick}
      sx={{
        height: "100%",
        cursor: onClick ? "pointer" : "default",
        transition: "transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out",
        opacity: isReachable ? 1 : 0.6,
        "&:hover": onClick
          ? {
              transform: "translateY(-4px)",
              boxShadow: 4,
            }
          : {},
      }}
    >
      <CardContent>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2, mb: 2 }}>
          <Box
            sx={{
              fontSize: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: 2,
              backgroundColor: `${getDeviceColor(deviceType)}20`,
            }}
          >
            {getDeviceIcon(deviceType)}
          </Box>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
                {name}
              </Typography>
              <Tooltip title={isReachable ? "Online" : "Offline"}>
                {isReachable ? (
                  <CheckCircleIcon color="success" fontSize="small" />
                ) : (
                  <ErrorIcon color="error" fontSize="small" />
                )}
              </Tooltip>
            </Box>
            {bridgeName && (
              <Typography variant="body2" color="text.secondary" noWrap>
                {bridgeName}
              </Typography>
            )}
            <Stack
              direction="row"
              spacing={0.5}
              sx={{ mt: 1, flexWrap: "wrap", gap: 0.5 }}
            >
              <Chip
                label={deviceType}
                size="small"
                sx={{
                  backgroundColor: `${getDeviceColor(deviceType)}20`,
                  color: getDeviceColor(deviceType),
                  fontWeight: 500,
                }}
              />
              {stateDisplay && (
                <Chip
                  label={stateDisplay}
                  size="small"
                  variant="outlined"
                  color={onOffState?.onOff ? "success" : "default"}
                />
              )}
            </Stack>
          </Box>
        </Box>

        <Box>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mb: 0.5 }}
          >
            Available Clusters ({clusters.length})
          </Typography>
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ flexWrap: "wrap", gap: 0.5 }}
          >
            {clusters.slice(0, 5).map((cluster) => (
              <Chip
                key={cluster}
                label={cluster}
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.7rem", height: 22 }}
              />
            ))}
            {clusters.length > 5 && (
              <Chip
                label={`+${clusters.length - 5} more`}
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.7rem", height: 22 }}
              />
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
};
