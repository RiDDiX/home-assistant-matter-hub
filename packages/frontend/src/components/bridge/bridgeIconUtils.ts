import type {
  BridgeDataWithMetadata,
  BridgeIconType,
} from "@home-assistant-matter-hub/common";
import { HomeAssistantMatcherType } from "@home-assistant-matter-hub/common";
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
import Window from "@mui/icons-material/Window";

export const iconTypeMap: Record<BridgeIconType, React.ElementType> = {
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

export const domainIconMap: Record<string, React.ElementType> = {
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

export const domainColorMap: Record<string, string> = {
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

export const getDomainFromBridge = (
  bridge: BridgeDataWithMetadata,
): string | null => {
  const domainMatcher = bridge.filter.include.find(
    (m) => m.type === HomeAssistantMatcherType.Domain,
  );
  return domainMatcher?.value ?? null;
};

export const getIconFromBridgeName = (
  name: string,
): React.ElementType | undefined => {
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
  return undefined;
};

export const getBridgeIcon = (
  bridge: BridgeDataWithMetadata,
): React.ElementType => {
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

export const getBridgeIconColor = (bridge: BridgeDataWithMetadata): string => {
  const domain = getDomainFromBridge(bridge);
  if (domain && domainColorMap[domain]) return domainColorMap[domain];
  if (bridge.deviceCount === 0) return "text.disabled";
  return "primary.main";
};
