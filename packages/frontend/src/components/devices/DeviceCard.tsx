import {
  type BridgeDataWithMetadata,
  type BridgeIconType,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import AcUnit from "@mui/icons-material/AcUnit";
import Battery from "@mui/icons-material/Battery80";
import Blinds from "@mui/icons-material/Blinds";
import Bolt from "@mui/icons-material/Bolt";
import Cameraswitch from "@mui/icons-material/Cameraswitch";
import CleaningServices from "@mui/icons-material/CleaningServices";
import DeviceHub from "@mui/icons-material/DeviceHub";
import Devices from "@mui/icons-material/Devices";
import DirectionsRun from "@mui/icons-material/DirectionsRun";
import DoorFront from "@mui/icons-material/DoorFront";
import ElectricalServices from "@mui/icons-material/ElectricalServices";
import EventNote from "@mui/icons-material/EventNote";
import Garage from "@mui/icons-material/Garage";
import Lightbulb from "@mui/icons-material/Lightbulb";
import Lock from "@mui/icons-material/Lock";
import PowerSettingsNew from "@mui/icons-material/PowerSettingsNew";
import Sensors from "@mui/icons-material/Sensors";
import SettingsRemote from "@mui/icons-material/SettingsRemote";
import Speaker from "@mui/icons-material/Speaker";
import Thermostat from "@mui/icons-material/Thermostat";
import Toys from "@mui/icons-material/Toys";
import Tv from "@mui/icons-material/Tv";
import WaterDrop from "@mui/icons-material/WaterDrop";
import Wifi from "@mui/icons-material/Wifi";
import Window from "@mui/icons-material/Window";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router";
import { navigation } from "../../routes.tsx";
import { BridgeStatusIcon } from "../bridge/BridgeStatusIcon.tsx";

export interface DeviceCardProps {
  bridge: BridgeDataWithMetadata;
}

const iconTypeMap: Record<BridgeIconType, React.ElementType> = {
  light: Lightbulb,
  switch: PowerSettingsNew,
  climate: Thermostat,
  cover: Blinds,
  fan: Toys,
  lock: Lock,
  sensor: Sensors,
  media_player: Tv,
  vacuum: CleaningServices,
  remote: SettingsRemote,
  humidifier: WaterDrop,
  speaker: Speaker,
  garage: Garage,
  door: DoorFront,
  window: Window,
  motion: DirectionsRun,
  battery: Battery,
  power: Bolt,
  camera: Cameraswitch,
  default: DeviceHub,
};

const domainIconMap: Record<string, React.ElementType> = {
  light: Lightbulb,
  switch: PowerSettingsNew,
  climate: Thermostat,
  cover: Blinds,
  fan: Toys,
  lock: Lock,
  sensor: Sensors,
  binary_sensor: Sensors,
  media_player: Tv,
  vacuum: CleaningServices,
  remote: SettingsRemote,
  humidifier: WaterDrop,
  input_boolean: ElectricalServices,
  input_button: EventNote,
  button: EventNote,
  scene: EventNote,
  script: EventNote,
  automation: EventNote,
  speaker: Speaker,
  air_quality: AcUnit,
  garage: Garage,
};

const domainColorMap: Record<string, string> = {
  light: "warning.main",
  switch: "info.main",
  climate: "error.main",
  cover: "success.main",
  fan: "info.light",
  lock: "secondary.main",
  sensor: "primary.main",
  binary_sensor: "primary.main",
  media_player: "secondary.main",
  vacuum: "success.main",
  remote: "warning.main",
  humidifier: "info.main",
};

const getDomainFromBridge = (bridge: BridgeDataWithMetadata): string | null => {
  const domainMatcher = bridge.filter.include.find(
    (m) => m.type === HomeAssistantMatcherType.Domain,
  );
  return domainMatcher?.value ?? null;
};

const getIconFromBridgeName = (name: string): React.ElementType | null => {
  const lowerName = name.toLowerCase();
  if (
    lowerName.includes("lamp") ||
    lowerName.includes("light") ||
    lowerName.includes("ljus")
  )
    return Lightbulb;
  if (lowerName.includes("vacuum") || lowerName.includes("dammsug"))
    return CleaningServices;
  if (
    lowerName.includes("thermo") ||
    lowerName.includes("climate") ||
    lowerName.includes("värme")
  )
    return Thermostat;
  if (lowerName.includes("sensor")) return Sensors;
  if (
    lowerName.includes("cover") ||
    lowerName.includes("blind") ||
    lowerName.includes("rullgardin") ||
    lowerName.includes("jalousie")
  )
    return Blinds;
  if (lowerName.includes("remote") || lowerName.includes("fjärr"))
    return SettingsRemote;
  if (lowerName.includes("lock") || lowerName.includes("lås")) return Lock;
  if (lowerName.includes("fan") || lowerName.includes("fläkt")) return Toys;
  if (lowerName.includes("tv") || lowerName.includes("media")) return Tv;
  if (lowerName.includes("speaker") || lowerName.includes("högtalare"))
    return Speaker;
  if (lowerName.includes("switch") || lowerName.includes("brytare"))
    return PowerSettingsNew;
  if (lowerName.includes("garage")) return Garage;
  return null;
};

const getDeviceIcon = (bridge: BridgeDataWithMetadata): React.ElementType => {
  // 1. Check if bridge has a configured icon
  if (bridge.icon && iconTypeMap[bridge.icon]) {
    return iconTypeMap[bridge.icon];
  }
  // 2. Try to get icon from domain filter
  const domain = getDomainFromBridge(bridge);
  if (domain && domainIconMap[domain]) return domainIconMap[domain];
  // 3. Try to infer from bridge name
  const nameIcon = getIconFromBridgeName(bridge.name);
  if (nameIcon) return nameIcon;
  // 4. Fallback
  if (bridge.deviceCount === 0) return Devices;
  return DeviceHub;
};

const getDeviceTypeColor = (bridge: BridgeDataWithMetadata): string => {
  const domain = getDomainFromBridge(bridge);
  if (domain && domainColorMap[domain]) return domainColorMap[domain];
  if (bridge.deviceCount === 0) return "text.disabled";
  return "primary.main";
};

export const DeviceCard = ({ bridge }: DeviceCardProps) => {
  const fabricCount = bridge.commissioning?.fabrics.length ?? 0;
  const DeviceIcon = getDeviceIcon(bridge);
  const deviceColor = getDeviceTypeColor(bridge);

  return (
    <Card
      variant="elevation"
      sx={{
        height: "100%",
        transition: "transform 0.2s ease-in-out, box-shadow 0.2s ease-in-out",
        "&:hover": {
          transform: "translateY(-4px)",
          boxShadow: 4,
        },
      }}
    >
      <CardActionArea
        component={RouterLink}
        to={navigation.bridge(bridge.id)}
        sx={{ height: "100%" }}
      >
        <CardContent>
          <Box display="flex" alignItems="flex-start" gap={2}>
            <Avatar
              sx={{
                bgcolor: deviceColor,
                width: 56,
                height: 56,
                boxShadow: 2,
              }}
            >
              <DeviceIcon sx={{ fontSize: 32 }} />
            </Avatar>
            <Box flexGrow={1} minWidth={0}>
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <Typography
                  variant="h6"
                  component="div"
                  noWrap
                  sx={{ flexGrow: 1, fontWeight: 600 }}
                >
                  {bridge.name}
                </Typography>
                <BridgeStatusIcon status={bridge.status} />
              </Box>

              <Stack spacing={1} mb={2}>
                <Box display="flex" alignItems="center" gap={1}>
                  <Devices sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    {bridge.deviceCount} devices
                  </Typography>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <Wifi sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    {fabricCount} fabric{fabricCount !== 1 ? "s" : ""}
                  </Typography>
                </Box>

                <Box display="flex" alignItems="center" gap={1}>
                  <Sensors sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" color="text.secondary">
                    Port {bridge.port}
                  </Typography>
                </Box>
              </Stack>

              <Chip
                label={bridge.status}
                size="small"
                color={
                  bridge.status === "running"
                    ? "success"
                    : bridge.status === "stopped"
                      ? "default"
                      : "error"
                }
                variant="outlined"
                sx={{ mt: 1 }}
              />
            </Box>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
};
