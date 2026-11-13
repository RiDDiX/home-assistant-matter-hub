import type { EndpointData } from "@home-assistant-matter-hub/common";
import type { SvgIconComponent } from "@mui/icons-material";
import BatteryAlertIcon from "@mui/icons-material/BatteryAlert";
import BatteryChargingFullIcon from "@mui/icons-material/BatteryChargingFull";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import BlindsIcon from "@mui/icons-material/Blinds";
import BoltIcon from "@mui/icons-material/Bolt";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import DevicesOtherIcon from "@mui/icons-material/DevicesOther";
import EditIcon from "@mui/icons-material/Edit";
import ErrorIcon from "@mui/icons-material/Error";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LightbulbIcon from "@mui/icons-material/Lightbulb";
import LinkIcon from "@mui/icons-material/Link";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import LocalLaundryServiceIcon from "@mui/icons-material/LocalLaundryService";
import LockIcon from "@mui/icons-material/Lock";
import MeetingRoomIcon from "@mui/icons-material/MeetingRoom";
import SensorOccupiedIcon from "@mui/icons-material/SensorOccupied";
import SensorsIcon from "@mui/icons-material/Sensors";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import SpeakerIcon from "@mui/icons-material/Speaker";
import ThermostatIcon from "@mui/icons-material/Thermostat";
import ToggleOnIcon from "@mui/icons-material/ToggleOn";
import TvIcon from "@mui/icons-material/Tv";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import WaterDamageIcon from "@mui/icons-material/WaterDamage";
import WaterDropIcon from "@mui/icons-material/WaterDrop";
import WindPowerIcon from "@mui/icons-material/WindPower";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceImageInfo } from "../../api/device-images";
import {
  deleteDeviceImage,
  getDeviceImageUrl,
  uploadDeviceImage,
} from "../../api/device-images";
import { useNotifications } from "../notifications/use-notifications";
import { getEndpointName } from "./EndpointName";
import { linkedEntities } from "./EndpointState";

// bigger hit area on touch screens only
const touchTarget = { "@media (pointer: coarse)": { p: 1.25 } };

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

interface ColorControlState {
  colorMode?: number;
  colorTemperatureMireds?: number;
  currentHue?: number;
  currentSaturation?: number;
}

interface MeasurementState {
  measuredValue?: number | null;
}

interface FanControlState {
  fanMode?: number;
  percentCurrent?: number;
}

interface WindowCoveringState {
  currentPositionLiftPercent100ths?: number;
}

interface DoorLockState {
  lockState?: number;
}

interface BooleanState {
  stateValue?: boolean;
  // contact sensors are inverted, detectors (leak, freeze, rain) are not
  config?: { inverted?: boolean };
}

interface StateChip {
  label: string;
  color?: "success" | "error" | "warning" | "info" | "default";
}

// First match wins, so the specific sensors come before the generic "sensor".
// Light colors keep 4.5:1 on their own tint in light mode.
const deviceStyles: [string[], SvgIconComponent, string, string][] = [
  [["contact"], MeetingRoomIcon, "#455A64", "#90A4AE"],
  [["occupancy"], SensorOccupiedIcon, "#C2185B", "#F48FB1"],
  [["smoke", "alarm"], LocalFireDepartmentIcon, "#BF360C", "#FF8A65"],
  [["leak", "freeze", "rain"], WaterDamageIcon, "#01579B", "#4FC3F7"],
  [["humidity"], WaterDropIcon, "#01579B", "#4FC3F7"],
  [
    ["thermostat", "temperature", "heater", "conditioner"],
    ThermostatIcon,
    "#BF360C",
    "#FF8A65",
  ],
  [["sensor"], SensorsIcon, "#7B1FA2", "#CE93D8"],
  [["light"], LightbulbIcon, "#8D5300", "#FFE082"],
  [["switch", "plugin", "onoff"], ToggleOnIcon, "#1B5E20", "#81C784"],
  [["lock"], LockIcon, "#1565C0", "#64B5F6"],
  [["fan", "air"], WindPowerIcon, "#006064", "#4DD0E1"],
  [["cover", "window"], BlindsIcon, "#5D4037", "#BCAAA4"],
  [["vacuum"], SmartToyIcon, "#616161", "#BDBDBD"],
  [["speaker"], SpeakerIcon, "#616161", "#BDBDBD"],
  [["video"], TvIcon, "#616161", "#BDBDBD"],
  [["battery", "solar", "meter", "evse"], BoltIcon, "#8D5300", "#FFE082"],
  [["valve", "pump", "water"], WaterDropIcon, "#01579B", "#4FC3F7"],
  [["laundry", "dishwasher"], LocalLaundryServiceIcon, "#616161", "#BDBDBD"],
];

const getDeviceStyle = (deviceType: string, isDark: boolean) => {
  const type = deviceType.toLowerCase();
  const match = deviceStyles.find(([keys]) =>
    keys.some((key) => type.includes(key)),
  );
  const [, Icon, light, dark] = match ?? [
    [],
    DevicesOtherIcon,
    "#616161",
    "#BDBDBD",
  ];
  return { Icon, color: isDark ? dark : light };
};

interface HomeAssistantEntityState {
  entity?: {
    entity_id?: string;
    state?: {
      state?: string;
      attributes?: {
        unit_of_measurement?: string;
        temperature_unit?: string;
      };
    };
  };
  mapping?: {
    batteryEntity?: string;
    humidityEntity?: string;
    pressureEntity?: string;
    powerEntity?: string;
    energyEntity?: string;
    voltageEntity?: string;
    currentEntity?: string;
    batteryPowerEntity?: string;
    batteryEnergyEntity?: string;
  };
}

interface PowerSourceState {
  batPercentRemaining?: number | null;
  batChargeState?: number;
}

const formatClusterValue = (value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string")
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length === 0 ? "{}" : `{${keys.length} keys}`;
  }
  return String(value);
};

// Matter carries temperatures in 0.01 C. Show them in the unit Home Assistant
// is set to: thermostats and water heaters carry it in the UI config cluster,
// sensors and weather in their own attributes (#472).
export const formatTemperature = (
  centiCelsius: number,
  state: Record<string, unknown>,
): string => {
  const displayMode = (
    state.thermostatUserInterfaceConfiguration as
      | { temperatureDisplayMode?: number }
      | undefined
  )?.temperatureDisplayMode;
  const attributes = (
    state.homeAssistantEntity as HomeAssistantEntityState | undefined
  )?.entity?.state?.attributes;
  const unit = attributes?.unit_of_measurement ?? attributes?.temperature_unit;
  const celsius = centiCelsius / 100;
  // 1 is Fahrenheit in ThermostatUserInterfaceConfiguration
  if (displayMode === 1 || unit === "°F" || unit === "F") {
    return `${(celsius * (9 / 5) + 32).toFixed(1)}°F`;
  }
  return `${celsius.toFixed(1)}°C`;
};

// Matter lift position is percent closed, 10000 is fully closed (#495).
export const coverOpenPercent = (liftPercent100ths: number): number =>
  Math.round((10000 - liftPercent100ths) / 100);

// global attributes every cluster carries, noise in the card details
const hiddenClusterKeys = new Set([
  "config",
  "clusterRevision",
  "featureMap",
  "attributeList",
  "acceptedCommandList",
  "generatedCommandList",
]);

export interface EndpointCardProps {
  endpoint: EndpointData;
  bridgeName?: string;
  bridgeId?: string;
  onClick?: () => void;
  onEditMapping?: (entityId: string, bridgeId: string) => void;
  imageInfo?: DeviceImageInfo;
  onImageChanged?: () => void;
}

export const EndpointCard = ({
  endpoint,
  bridgeName,
  bridgeId,
  onClick,
  onEditMapping,
  imageInfo,
  onImageChanged,
}: EndpointCardProps) => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const name = getEndpointName(endpoint.state) ?? endpoint.id.local;
  const deviceType = endpoint.type.name;
  const { Icon: DeviceIcon, color: deviceColor } = getDeviceStyle(
    deviceType,
    isDark,
  );
  const detailsId = useId();

  const basicInfo = useMemo(() => {
    const state = endpoint.state as {
      bridgedDeviceBasicInformation?: BasicInfo;
    };
    return state.bridgedDeviceBasicInformation;
  }, [endpoint.state]);

  const isReachable = basicInfo?.reachable ?? true;

  const haEntity = useMemo(() => {
    const state = endpoint.state as {
      homeAssistantEntity?: HomeAssistantEntityState;
    };
    return state.homeAssistantEntity;
  }, [endpoint.state]);

  const entityId = haEntity?.entity?.entity_id;
  const haState = haEntity?.entity?.state?.state;
  const isUnavailable = haState === "unavailable" || haState === "unknown";

  const mapping = haEntity?.mapping;
  const autoMappings = useMemo(() => linkedEntities(mapping), [mapping]);

  const autoMappedClusters = useMemo(() => {
    const set = new Set<string>();
    if (mapping?.batteryEntity) set.add("powerSource");
    if (mapping?.humidityEntity) set.add("relativeHumidityMeasurement");
    if (mapping?.pressureEntity) set.add("pressureMeasurement");
    if (mapping?.powerEntity) set.add("electricalPowerMeasurement");
    if (mapping?.energyEntity) set.add("electricalEnergyMeasurement");
    if (mapping?.voltageEntity) set.add("electricalPowerMeasurement");
    if (mapping?.currentEntity) set.add("electricalPowerMeasurement");
    if (mapping?.batteryPowerEntity) set.add("electricalPowerMeasurement");
    if (mapping?.batteryEnergyEntity) set.add("electricalEnergyMeasurement");
    return set;
  }, [mapping]);

  const powerSource = useMemo(() => {
    const state = endpoint.state as { powerSource?: PowerSourceState };
    return state.powerSource;
  }, [endpoint.state]);

  const batteryPercent = useMemo(() => {
    if (powerSource?.batPercentRemaining == null) return null;
    return Math.round(powerSource.batPercentRemaining / 2);
  }, [powerSource]);

  // batChargeState: 0=Unknown, 1=IsCharging, 2=IsAtFullCharge, 3=IsNotCharging
  const isCharging =
    powerSource?.batChargeState === 1 || powerSource?.batChargeState === 2;

  const [expanded, setExpanded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [imgVersion, setImgVersion] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasImage = imageInfo && imageInfo.source !== "none" && !imgError;
  const imageUrl = useMemo(() => {
    if (!imageInfo || imageInfo.source === "none") return undefined;
    if (imageInfo.source === "custom" && entityId) {
      return `${getDeviceImageUrl(entityId)}?v=${imgVersion}`;
    }
    if (imageInfo.source === "z2m" && imageInfo.z2mUrl) {
      return imageInfo.z2mUrl;
    }
    return undefined;
  }, [imageInfo, entityId, imgVersion]);

  const handleUploadClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !entityId) return;
      try {
        await uploadDeviceImage(entityId, file);
        setImgError(false);
        setImgVersion((v) => v + 1);
        onImageChanged?.();
      } catch (err) {
        notifications.show({
          message: t("endpoints.imageUploadFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
          severity: "error",
        });
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [entityId, onImageChanged, notifications, t],
  );

  const handleDeleteImage = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!entityId) return;
      try {
        await deleteDeviceImage(entityId);
        setImgError(false);
        setImgVersion((v) => v + 1);
        onImageChanged?.();
      } catch (err) {
        notifications.show({
          message: t("endpoints.imageDeleteFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
          severity: "error",
        });
      }
    },
    [entityId, onImageChanged, notifications, t],
  );

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

  const stateChips = useMemo(() => {
    const s = endpoint.state as Record<string, unknown>;
    const chips: StateChip[] = [];

    const onOff = s.onOff as OnOffState | undefined;
    const level = s.levelControl as LevelControlState | undefined;
    const thermo = s.thermostat as ThermostatState | undefined;
    const color = s.colorControl as ColorControlState | undefined;
    const fan = s.fanControl as FanControlState | undefined;
    const temp = s.temperatureMeasurement as MeasurementState | undefined;
    const humidity = s.relativeHumidityMeasurement as
      | MeasurementState
      | undefined;
    const pressure = s.pressureMeasurement as MeasurementState | undefined;
    const illuminance = s.illuminanceMeasurement as
      | MeasurementState
      | undefined;
    const co2 = s.carbonDioxideConcentrationMeasurement as
      | MeasurementState
      | undefined;
    const pm25 = s.pm25ConcentrationMeasurement as MeasurementState | undefined;
    const tvoc = s.totalVolatileOrganicCompoundsConcentrationMeasurement as
      | MeasurementState
      | undefined;
    const cover = s.windowCovering as WindowCoveringState | undefined;
    const lock = s.doorLock as DoorLockState | undefined;
    const boolean = s.booleanState as BooleanState | undefined;

    // On/Off state
    if (onOff?.onOff !== undefined) {
      chips.push({
        label: onOff.onOff ? t("endpoints.state.on") : t("endpoints.state.off"),
        color: onOff.onOff ? "success" : "default",
      });
    }

    // Brightness (only if on)
    if (level?.currentLevel !== undefined) {
      const percent = Math.round((level.currentLevel / 254) * 100);
      chips.push({ label: `${percent}%` });
    }

    // Color temperature (only for CT mode)
    if (
      color?.colorTemperatureMireds != null &&
      color.colorTemperatureMireds > 0
    ) {
      const kelvin = Math.round(1000000 / color.colorTemperatureMireds);
      chips.push({ label: `${kelvin}K` });
    }

    // Thermostat
    if (thermo?.localTemperature != null) {
      chips.push({ label: formatTemperature(thermo.localTemperature, s) });
    }
    if (thermo?.systemMode !== undefined) {
      const modes: Record<number, string> = {
        0: "off",
        1: "auto",
        3: "cool",
        4: "heat",
        7: "fan",
        8: "dry",
      };
      const mode = modes[thermo.systemMode];
      if (mode) {
        chips.push({
          label: t(`endpoints.state.${mode}`),
          color: thermo.systemMode === 0 ? "default" : "info",
        });
      }
    }

    // Temperature sensor
    if (temp?.measuredValue != null) {
      chips.push({ label: formatTemperature(temp.measuredValue, s) });
    }

    // Humidity sensor
    if (humidity?.measuredValue != null) {
      const h = humidity.measuredValue / 100;
      chips.push({ label: `${h.toFixed(0)}% RH` });
    }

    // Pressure sensor
    if (pressure?.measuredValue != null) {
      chips.push({ label: `${pressure.measuredValue} hPa` });
    }

    // Illuminance sensor
    if (illuminance?.measuredValue != null && illuminance.measuredValue > 0) {
      const lux = Math.round(10 ** ((illuminance.measuredValue - 1) / 10000));
      chips.push({ label: `${lux} lx` });
    }

    // CO2 sensor
    if (co2?.measuredValue != null) {
      chips.push({ label: `${Math.round(co2.measuredValue)} ppm CO2` });
    }

    // PM2.5 sensor
    if (pm25?.measuredValue != null) {
      chips.push({ label: `PM2.5: ${Math.round(pm25.measuredValue)}` });
    }

    // TVOC sensor
    if (tvoc?.measuredValue != null) {
      chips.push({ label: `TVOC: ${Math.round(tvoc.measuredValue)}` });
    }

    // Fan
    if (fan?.percentCurrent != null && fan.percentCurrent > 0) {
      chips.push({
        label: t("endpoints.state.fanPercent", {
          percent: fan.percentCurrent,
        }),
      });
    }

    // Window covering
    if (cover?.currentPositionLiftPercent100ths != null) {
      chips.push({
        label: t("endpoints.state.percentOpen", {
          percent: coverOpenPercent(cover.currentPositionLiftPercent100ths),
        }),
      });
    }

    // Door lock
    if (lock?.lockState !== undefined) {
      const locked = lock.lockState === 1;
      chips.push({
        label: locked
          ? t("endpoints.state.locked")
          : t("endpoints.state.unlocked"),
        color: locked ? "success" : "warning",
      });
    }

    // Boolean state: contact sensors report true for closed, detectors for detected
    if (boolean?.stateValue !== undefined && onOff?.onOff === undefined) {
      // plugin contact sensors carry no HAMH config but are contacts
      const isContact =
        boolean.config?.inverted === true ||
        (endpoint.type.name === "ContactSensor" && !s.homeAssistantEntity);
      if (isContact) {
        chips.push({
          label: boolean.stateValue
            ? t("endpoints.state.closed")
            : t("endpoints.state.open"),
          color: boolean.stateValue ? "success" : "warning",
        });
      } else {
        chips.push({
          label: boolean.stateValue
            ? t("endpoints.state.detected")
            : t("endpoints.state.clear"),
          color: boolean.stateValue ? "error" : "success",
        });
      }
    }

    return chips;
  }, [endpoint.state, endpoint.type.name, t]);

  return (
    <Card
      onClick={onClick}
      sx={{
        height: "100%",
        cursor: onClick ? "pointer" : "default",
        "&:hover": onClick ? { borderColor: "primary.main" } : {},
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
              backgroundColor: `${deviceColor}20`,
              overflow: "hidden",
              flexShrink: 0,
              // dim only the icon, dimming the card fails text contrast
              opacity: isReachable ? 1 : 0.5,
            }}
          >
            {hasImage && imageUrl ? (
              <Box
                component="img"
                src={imageUrl}
                alt={name}
                onError={() => setImgError(true)}
                sx={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            ) : (
              <DeviceIcon sx={{ fontSize: 32, color: deviceColor }} />
            )}
          </Box>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                // phones: actions move under the name so it stays readable
                flexWrap: { xs: "wrap", sm: "nowrap" },
              }}
            >
              <Typography
                variant="h6"
                title={name}
                sx={{
                  flexBasis: { xs: "100%", sm: "auto" },
                  flexGrow: 1,
                  minWidth: 0,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  wordBreak: "break-word",
                }}
              >
                {name}
              </Typography>
              {entityId && (
                <>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    style={{ display: "none" }}
                  />
                  <Tooltip title={t("endpoints.uploadImage")}>
                    <IconButton
                      size="small"
                      onClick={handleUploadClick}
                      sx={{ ml: 0.5, ...touchTarget }}
                      aria-label={`${t("endpoints.uploadImage")}: ${name}`}
                    >
                      <CameraAltIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  {imageInfo?.source === "custom" && (
                    <Tooltip title={t("endpoints.removeImage")}>
                      <IconButton
                        size="small"
                        onClick={handleDeleteImage}
                        sx={{ ml: -0.5, ...touchTarget }}
                        aria-label={`${t("endpoints.removeImage")}: ${name}`}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </>
              )}
              {onEditMapping && entityId && bridgeId && (
                <Tooltip title={t("endpoints.editMapping")}>
                  <IconButton
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditMapping(entityId, bridgeId);
                    }}
                    sx={{ ml: 0.5, ...touchTarget }}
                    aria-label={`${t("endpoints.editMapping")}: ${name}`}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {isUnavailable ? (
                <Tooltip title={`${t("endpoints.haState")}: ${haState}`}>
                  <WarningAmberIcon color="warning" fontSize="small" />
                </Tooltip>
              ) : (
                <Tooltip
                  title={isReachable ? t("common.online") : t("common.offline")}
                >
                  {isReachable ? (
                    <CheckCircleIcon color="success" fontSize="small" />
                  ) : (
                    <ErrorIcon color="error" fontSize="small" />
                  )}
                </Tooltip>
              )}
            </Box>
            {entityId && (
              <Typography
                variant="caption"
                color="text.secondary"
                fontFamily="monospace"
                display="block"
                noWrap
                title={entityId}
              >
                {entityId}
              </Typography>
            )}
            {bridgeName && (
              <Typography
                variant="body2"
                color="text.secondary"
                noWrap
                title={bridgeName}
              >
                {bridgeName}
              </Typography>
            )}
            <Stack
              direction="row"
              spacing={0.5}
              useFlexGap
              sx={{ mt: 1, flexWrap: "wrap", gap: 0.5 }}
            >
              <Tooltip
                title={t("endpoints.deviceTypeId", { id: endpoint.type.id })}
              >
                <Chip
                  label={`${deviceType} (${endpoint.type.id})`}
                  size="small"
                  sx={{
                    backgroundColor: `${deviceColor}20`,
                    color: deviceColor,
                    fontWeight: 500,
                  }}
                />
              </Tooltip>
              {stateChips.map((chip) => (
                <Chip
                  key={chip.label}
                  label={chip.label}
                  size="small"
                  variant="outlined"
                  color={chip.color ?? "default"}
                />
              ))}
            </Stack>
          </Box>
        </Box>

        {/* Battery & Auto-Mappings */}
        {(batteryPercent != null || autoMappings.length > 0) && (
          <>
            <Divider sx={{ my: 1 }} />
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              alignItems="center"
              sx={{ flexWrap: "wrap", gap: 0.5, mb: 1 }}
            >
              {batteryPercent != null && (
                <Chip
                  icon={
                    isCharging ? (
                      <BatteryChargingFullIcon />
                    ) : batteryPercent <= 20 ? (
                      <BatteryAlertIcon />
                    ) : (
                      <BatteryFullIcon />
                    )
                  }
                  label={`${batteryPercent}%`}
                  size="small"
                  color={
                    isCharging
                      ? "info"
                      : batteryPercent <= 10
                        ? "error"
                        : batteryPercent <= 20
                          ? "warning"
                          : "success"
                  }
                  variant="outlined"
                />
              )}
              {autoMappings.map((m) => (
                <Tooltip key={m.field} title={m.entity}>
                  <Chip
                    icon={<LinkIcon />}
                    label={t(`endpoints.linked.${m.field}`)}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: "0.7rem", height: 22 }}
                  />
                </Tooltip>
              ))}
            </Stack>
          </>
        )}

        {/* Clusters */}
        <Box>
          <Box display="flex" alignItems="center" gap={1}>
            <ButtonBase
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(!expanded);
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                width: "100%",
                textAlign: "left",
                borderRadius: 1,
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexGrow: 1 }}
              >
                {t("endpoints.clusters")} ({clusters.length})
              </Typography>
              <ExpandMoreIcon
                sx={{
                  fontSize: 16,
                  color: "text.secondary",
                  transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.2s",
                }}
              />
            </ButtonBase>
            {/* the card click opens the same dialog, this makes it reachable by keyboard */}
            {onClick && (
              <Tooltip title={t("endpoints.showDetails")}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClick();
                  }}
                  aria-label={`${t("endpoints.showDetails")}: ${name}`}
                  sx={touchTarget}
                >
                  <InfoOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <Stack
            direction="row"
            spacing={0.5}
            useFlexGap
            sx={{ flexWrap: "wrap", gap: 0.5, mt: 0.5 }}
          >
            {clusters.slice(0, expanded ? undefined : 5).map((cluster) => {
              const isAutoMapped = autoMappedClusters.has(cluster);
              return (
                <Tooltip
                  key={cluster}
                  title={
                    isAutoMapped
                      ? t("endpoints.autoMappedCluster")
                      : t("endpoints.deviceCluster")
                  }
                >
                  <Chip
                    icon={isAutoMapped ? <LinkIcon /> : undefined}
                    label={cluster}
                    size="small"
                    variant="outlined"
                    color={isAutoMapped ? "info" : "default"}
                    sx={{ fontSize: "0.7rem", height: 22 }}
                  />
                </Tooltip>
              );
            })}
            {!expanded && clusters.length > 5 && (
              <Chip
                label={`+${clusters.length - 5}`}
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.7rem", height: 22 }}
              />
            )}
          </Stack>
        </Box>

        {/* Expanded: Cluster state details + HA entity info */}
        <Collapse in={expanded} id={detailsId}>
          <Divider sx={{ my: 1 }} />
          <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
            {/* HA Entity Info */}
            {entityId && (
              <Box sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mb: 0.5 }}
                >
                  {t("endpoints.homeAssistantEntity")}
                </Typography>
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize="0.75rem"
                >
                  {t("endpoints.haState")}: {haState ?? t("common.unknown")}
                </Typography>
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize="0.75rem"
                >
                  {`${t("mapping.deviceType")}: ${endpoint.type.name} (${endpoint.type.id})`}
                </Typography>
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize="0.75rem"
                >
                  {t("endpoints.endpointNumber")}: {endpoint.endpoint ?? "-"}
                </Typography>
              </Box>
            )}

            {/* Cluster State Details */}
            {clusters.map((cluster) => {
              const clusterState = (endpoint.state as Record<string, unknown>)[
                cluster
              ];
              if (
                !clusterState ||
                typeof clusterState !== "object" ||
                Object.keys(clusterState as object).length === 0
              ) {
                return null;
              }
              const entries = Object.entries(
                clusterState as Record<string, unknown>,
              ).filter(
                ([k]) => !k.startsWith("__") && !hiddenClusterKeys.has(k),
              );
              if (entries.length === 0) return null;
              return (
                <Box key={cluster} sx={{ mb: 1 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    fontWeight={600}
                    sx={{ display: "block", mb: 0.25 }}
                  >
                    {cluster}
                  </Typography>
                  {entries.map(([key, value]) => (
                    <Typography
                      key={key}
                      variant="body2"
                      fontFamily="monospace"
                      fontSize="0.7rem"
                      color="text.secondary"
                      noWrap
                    >
                      {key}: {formatClusterValue(value)}
                    </Typography>
                  ))}
                </Box>
              );
            })}
          </Box>
        </Collapse>
      </CardContent>
    </Card>
  );
};
