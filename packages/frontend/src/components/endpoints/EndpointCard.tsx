import type { EndpointData } from "@home-assistant-matter-hub/common";
import BatteryAlertIcon from "@mui/icons-material/BatteryAlert";
import BatteryChargingFullIcon from "@mui/icons-material/BatteryChargingFull";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import ErrorIcon from "@mui/icons-material/Error";
import LinkIcon from "@mui/icons-material/Link";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
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
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceImageInfo } from "../../api/device-images";
import {
  deleteDeviceImage,
  getDeviceImageUrl,
  uploadDeviceImage,
} from "../../api/device-images";
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
}

interface StateChip {
  label: string;
  color?: "success" | "error" | "warning" | "info" | "default";
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

const getDeviceColor = (deviceType: string, isDark: boolean): string => {
  const type = deviceType.toLowerCase();
  if (isDark) {
    if (type.includes("light")) return "#FFE082";
    if (type.includes("switch") || type.includes("plugin")) return "#81C784";
    if (type.includes("lock")) return "#64B5F6";
    if (type.includes("thermostat")) return "#FF8A65";
    if (type.includes("temperature")) return "#FF8A65";
    if (type.includes("humidity")) return "#4FC3F7";
    if (type.includes("sensor")) return "#CE93D8";
    if (type.includes("fan")) return "#4DD0E1";
    if (type.includes("cover") || type.includes("window")) return "#A1887F";
    if (type.includes("contact")) return "#90A4AE";
    if (type.includes("occupancy")) return "#F48FB1";
    return "#BDBDBD";
  }
  if (type.includes("light")) return "#F9A825";
  if (type.includes("switch") || type.includes("plugin")) return "#388E3C";
  if (type.includes("lock")) return "#1976D2";
  if (type.includes("thermostat")) return "#E64A19";
  if (type.includes("temperature")) return "#E64A19";
  if (type.includes("humidity")) return "#0288D1";
  if (type.includes("sensor")) return "#7B1FA2";
  if (type.includes("fan")) return "#00838F";
  if (type.includes("cover") || type.includes("window")) return "#5D4037";
  if (type.includes("contact")) return "#455A64";
  if (type.includes("occupancy")) return "#C2185B";
  return "#616161";
};

interface HomeAssistantEntityState {
  entity?: {
    entity_id?: string;
    state?: {
      state?: string;
    };
  };
  mapping?: {
    batteryEntity?: string;
    humidityEntity?: string;
    pressureEntity?: string;
    powerEntity?: string;
    energyEntity?: string;
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
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const name = getEndpointName(endpoint.state) ?? endpoint.id.local;
  const deviceType = endpoint.type.name;

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
  const autoMappings = useMemo(() => {
    const mappings: { label: string; entity: string }[] = [];
    if (mapping?.batteryEntity) {
      mappings.push({ label: "Battery", entity: mapping.batteryEntity });
    }
    if (mapping?.humidityEntity) {
      mappings.push({ label: "Humidity", entity: mapping.humidityEntity });
    }
    if (mapping?.pressureEntity) {
      mappings.push({ label: "Pressure", entity: mapping.pressureEntity });
    }
    if (mapping?.powerEntity) {
      mappings.push({ label: "Power", entity: mapping.powerEntity });
    }
    if (mapping?.energyEntity) {
      mappings.push({ label: "Energy", entity: mapping.energyEntity });
    }
    return mappings;
  }, [mapping]);

  const autoMappedClusters = useMemo(() => {
    const set = new Set<string>();
    if (mapping?.batteryEntity) set.add("powerSource");
    if (mapping?.humidityEntity) set.add("relativeHumidityMeasurement");
    if (mapping?.pressureEntity) set.add("pressureMeasurement");
    if (mapping?.powerEntity) set.add("electricalPowerMeasurement");
    if (mapping?.energyEntity) set.add("electricalEnergyMeasurement");
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
        console.error("Failed to upload device image:", err);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [entityId, onImageChanged],
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
        console.error("Failed to delete device image:", err);
      }
    },
    [entityId, onImageChanged],
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
        label: onOff.onOff ? "On" : "Off",
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
      const t = thermo.localTemperature / 100;
      chips.push({ label: `${t.toFixed(1)}°C` });
    }
    if (thermo?.systemMode !== undefined) {
      const modes: Record<number, string> = {
        0: "Off",
        1: "Auto",
        3: "Cool",
        4: "Heat",
        7: "Fan",
        8: "Dry",
      };
      const mode = modes[thermo.systemMode];
      if (mode) {
        chips.push({
          label: mode,
          color: thermo.systemMode === 0 ? "default" : "info",
        });
      }
    }

    // Temperature sensor
    if (temp?.measuredValue != null) {
      const t = temp.measuredValue / 100;
      chips.push({ label: `${t.toFixed(1)}°C` });
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
      chips.push({ label: `Fan ${fan.percentCurrent}%` });
    }

    // Window covering
    if (cover?.currentPositionLiftPercent100ths != null) {
      const pos = Math.round(cover.currentPositionLiftPercent100ths / 100);
      chips.push({ label: `${pos}% open` });
    }

    // Door lock
    if (lock?.lockState !== undefined) {
      const locked = lock.lockState === 1;
      chips.push({
        label: locked ? "Locked" : "Unlocked",
        color: locked ? "success" : "warning",
      });
    }

    // Boolean state (contact sensors, etc.)
    if (boolean?.stateValue !== undefined && onOff?.onOff === undefined) {
      chips.push({
        label: boolean.stateValue ? "Closed" : "Open",
        color: boolean.stateValue ? "success" : "warning",
      });
    }

    return chips;
  }, [endpoint.state]);

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
              backgroundColor: `${getDeviceColor(deviceType, isDark)}20`,
              overflow: "hidden",
              flexShrink: 0,
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
              getDeviceIcon(deviceType)
            )}
          </Box>
        </Box>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          {/* Top row: name, image upload, edit, status */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="h6" noWrap sx={{ flexGrow: 1 }}>
              {name}
            </Typography>
            {/* Upload and remove image buttons */}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              style={{ display: "none" }}
              ref={fileInputRef}
              onChange={handleFileChange}
            />
            <Tooltip title={t("endpoints.uploadImage")}>
              <IconButton
                size="small"
                onClick={handleUploadClick}
                sx={{ ml: 0.5 }}
                aria-label={`Upload image for ${name}`}
              >
                <CameraAltIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            {imageInfo?.source === "custom" && (
              <Tooltip title={t("endpoints.removeImage")}>
                <IconButton
                  size="small"
                  onClick={handleDeleteImage}
                  sx={{ ml: -0.5 }}
                  aria-label={`Remove image for ${name}`}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {onEditMapping && entityId && bridgeId && (
              <Tooltip title={t("endpoints.editMapping")}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditMapping(entityId, bridgeId);
                  }}
                  sx={{ ml: 0.5 }}
                  aria-label={`Edit mapping for ${name}`}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {isUnavailable ? (
              <Tooltip title={`HA State: ${haState}`}>
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
          {/* Entity ID and bridge name */}
          {entityId && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace" }}
              noWrap
            >
              {entityId}
            </Typography>
          )}
          {bridgeName && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {bridgeName}
            </Typography>
          )}
          {/* State chips */}
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ mt: 1, flexWrap: "wrap", gap: 0.5 }}
          >
            <Tooltip title={`Device Type ID: ${endpoint.type.id}`}>
              <Chip
                label={`${deviceType} (${endpoint.type.id})`}
                size="small"
                sx={{
                  backgroundColor: `${getDeviceColor(deviceType, isDark)}20`,
                  color: getDeviceColor(deviceType, isDark),
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
          {/* Battery and auto-mapping chips */}
          <Divider sx={{ my: 1 }} />
          <Stack
            direction="row"
            spacing={1}
            sx={{ flexWrap: "wrap", gap: 0.5, mb: 1, alignItems: "center" }}
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
              <Tooltip key={m.label} title={m.entity}>
                <Chip
                  icon={<LinkIcon />}
                  label={m.label}
                  size="small"
                  variant="outlined"
                  sx={{ fontSize: "0.7rem", height: 22 }}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>

        {/* Clusters */}
        <Box>
          <Box
            sx={{ display: "flex", alignItems: "center", cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexGrow: 1 }}
            >
              {t("endpoints.clusters")} ({clusters.length})
            </Typography>
            {clusters.slice(0, expanded ? undefined : 5).map((cluster) => {
              const isAutoMapped = autoMappedClusters.has(cluster);
              return (
                <Tooltip
                  key={cluster}
                  title={
                    isAutoMapped
                      ? `Auto-mapped from linked entity`
                      : `Device cluster`
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
          </Box>
        </Box>

        {/* Expanded: Cluster state details + HA entity info */}
        <Collapse in={expanded}>
          <Divider sx={{ my: 1 }} />

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
                sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}
              >
                {t("endpoints.haState")}: {haState ?? t("common.unknown")}
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}
              >
                Device Type: {endpoint.type.name} ({endpoint.type.id})
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 1, fontWeight: 600 }}
              >
                Endpoint: {endpoint.endpoint ?? "N/A"}
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
            ).filter(([k]) => !k.startsWith("__") && k !== "config");
            if (entries.length === 0) return null;
            return (
              <Box key={cluster} sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mb: 0.25, fontWeight: 600 }}
                >
                  {cluster}
                </Typography>
                {entries.map(([key, value]) => (
                  <Typography
                    key={key}
                    variant="body2"
                    color="text.secondary"
                    noWrap
                    sx={{ fontFamily: "monospace", fontSize: "0.7rem" }}
                  >
                    {key}: {formatClusterValue(value)}
                  </Typography>
                ))}
              </Box>
            );
          })}
        </Collapse>
      </CardContent>
    </Card>
  );
};
