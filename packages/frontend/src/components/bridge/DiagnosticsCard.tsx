import type { EndpointData } from "@home-assistant-matter-hub/common";
import BatteryAlertIcon from "@mui/icons-material/BatteryAlert";
import BatteryChargingFullIcon from "@mui/icons-material/BatteryChargingFull";
import BatteryFullIcon from "@mui/icons-material/BatteryFull";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import LinkIcon from "@mui/icons-material/Link";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { getEndpointName } from "../endpoints/EndpointName";

interface HaEntityState {
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

interface EntityDiagnostic {
  name: string;
  entityId: string;
  haState: string;
  isUnavailable: boolean;
  batteryPercent: number | null;
  isCharging: boolean;
  clusters: string[];
  autoMappings: { label: string; entity: string }[];
}

const collectLeafEndpoints = (endpoint: EndpointData): EndpointData[] => {
  const parts = endpoint.parts ?? [];
  if (parts.length === 0) {
    return [endpoint];
  }
  return parts.flatMap((part) => collectLeafEndpoints(part));
};

const extractDiagnostics = (
  endpoint: EndpointData,
): EntityDiagnostic | null => {
  const state = endpoint.state as {
    homeAssistantEntity?: HaEntityState;
    powerSource?: PowerSourceState;
  };

  const ha = state.homeAssistantEntity;
  const entityId = ha?.entity?.entity_id;
  if (!entityId) return null;

  const haState = ha?.entity?.state?.state ?? "unknown";
  const isUnavailable = haState === "unavailable" || haState === "unknown";

  const ps = state.powerSource;
  const batteryPercent =
    ps?.batPercentRemaining != null
      ? Math.round(ps.batPercentRemaining / 2)
      : null;
  const isCharging = ps?.batChargeState === 1 || ps?.batChargeState === 2;

  const clusters = Object.keys(endpoint.state).filter(
    (k) =>
      ![
        "homeAssistantEntity",
        "bridgedDeviceBasicInformation",
        "identify",
      ].includes(k),
  );

  const autoMappings: { label: string; entity: string }[] = [];
  if (ha?.mapping?.batteryEntity) {
    autoMappings.push({ label: "Battery", entity: ha.mapping.batteryEntity });
  }
  if (ha?.mapping?.humidityEntity) {
    autoMappings.push({ label: "Humidity", entity: ha.mapping.humidityEntity });
  }
  if (ha?.mapping?.pressureEntity) {
    autoMappings.push({ label: "Pressure", entity: ha.mapping.pressureEntity });
  }
  if (ha?.mapping?.powerEntity) {
    autoMappings.push({ label: "Power", entity: ha.mapping.powerEntity });
  }
  if (ha?.mapping?.energyEntity) {
    autoMappings.push({ label: "Energy", entity: ha.mapping.energyEntity });
  }

  return {
    name: getEndpointName(endpoint.state) ?? endpoint.id.local,
    entityId,
    haState,
    isUnavailable,
    batteryPercent,
    isCharging,
    clusters,
    autoMappings,
  };
};

export interface DiagnosticsCardProps {
  devices: EndpointData;
}

export const DiagnosticsCard = ({ devices }: DiagnosticsCardProps) => {
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [showBatteries, setShowBatteries] = useState(false);
  const [showMappings, setShowMappings] = useState(false);

  const diagnostics = useMemo(() => {
    const leafEndpoints = collectLeafEndpoints(devices);
    return leafEndpoints
      .map(extractDiagnostics)
      .filter((d): d is EntityDiagnostic => d !== null);
  }, [devices]);

  const unavailable = useMemo(
    () => diagnostics.filter((d) => d.isUnavailable),
    [diagnostics],
  );

  const withBattery = useMemo(
    () => diagnostics.filter((d) => d.batteryPercent != null),
    [diagnostics],
  );

  const withMappings = useMemo(
    () => diagnostics.filter((d) => d.autoMappings.length > 0),
    [diagnostics],
  );

  const healthy = diagnostics.length - unavailable.length;

  return (
    <Card>
      <CardContent>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
          <Avatar sx={{ bgcolor: "secondary.main" }}>
            <MonitorHeartIcon />
          </Avatar>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Diagnostics
          </Typography>
        </Box>

        {/* Summary Row */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ mb: 1, flexWrap: "wrap" }}
        >
          <Chip
            icon={<CheckCircleIcon />}
            label={`${healthy} Healthy`}
            color="success"
            size="small"
            variant="outlined"
          />
          {unavailable.length > 0 && (
            <Chip
              icon={<WarningAmberIcon />}
              label={`${unavailable.length} Unavailable`}
              color="warning"
              size="small"
              variant="outlined"
              onClick={() => setShowUnavailable(!showUnavailable)}
              sx={{ cursor: "pointer" }}
            />
          )}
          {withBattery.length > 0 && (
            <Chip
              icon={<BatteryFullIcon />}
              label={`${withBattery.length} Battery`}
              color="info"
              size="small"
              variant="outlined"
              onClick={() => setShowBatteries(!showBatteries)}
              sx={{ cursor: "pointer" }}
            />
          )}
          {withMappings.length > 0 && (
            <Chip
              icon={<LinkIcon />}
              label={`${withMappings.length} Auto-Mapped`}
              size="small"
              variant="outlined"
              onClick={() => setShowMappings(!showMappings)}
              sx={{ cursor: "pointer" }}
            />
          )}
        </Stack>

        {/* Unavailable Entities */}
        <Collapse in={showUnavailable && unavailable.length > 0}>
          <Divider sx={{ mb: 1 }} />
          <Typography variant="subtitle2" color="warning.main" gutterBottom>
            Unavailable Entities
          </Typography>
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            {unavailable.map((d) => (
              <Box
                key={d.entityId}
                sx={{ display: "flex", alignItems: "center", gap: 1 }}
              >
                <WarningAmberIcon color="warning" sx={{ fontSize: 16 }} />
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {d.name}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ fontFamily: "monospace" }}
                >
                  {d.entityId}
                </Typography>
                <Chip
                  label={d.haState}
                  size="small"
                  color="warning"
                  variant="outlined"
                  sx={{ fontSize: "0.7rem", height: 20, ml: "auto" }}
                />
              </Box>
            ))}
          </Stack>
        </Collapse>

        {/* Battery Overview */}
        <Collapse in={showBatteries && withBattery.length > 0}>
          <Divider sx={{ mb: 1 }} />
          <Typography variant="subtitle2" color="info.main" gutterBottom>
            Battery Levels
          </Typography>
          <Stack spacing={1} sx={{ mb: 1 }}>
            {withBattery
              .sort((a, b) => (a.batteryPercent ?? 0) - (b.batteryPercent ?? 0))
              .map((d) => (
                <Box key={d.entityId}>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      mb: 0.5,
                    }}
                  >
                    {d.isCharging ? (
                      <BatteryChargingFullIcon
                        color="info"
                        sx={{ fontSize: 16 }}
                      />
                    ) : (d.batteryPercent ?? 0) <= 20 ? (
                      <BatteryAlertIcon color="warning" sx={{ fontSize: 16 }} />
                    ) : (
                      <BatteryFullIcon color="success" sx={{ fontSize: 16 }} />
                    )}
                    <Typography variant="body2" sx={{ flexGrow: 1 }}>
                      {d.name}
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {d.batteryPercent}%{d.isCharging ? " ⚡" : ""}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={d.batteryPercent ?? 0}
                    color={
                      (d.batteryPercent ?? 0) <= 10
                        ? "error"
                        : (d.batteryPercent ?? 0) <= 20
                          ? "warning"
                          : "success"
                    }
                    sx={{ height: 4, borderRadius: 2 }}
                  />
                </Box>
              ))}
          </Stack>
        </Collapse>

        {/* Auto-Mappings */}
        <Collapse in={showMappings && withMappings.length > 0}>
          <Divider sx={{ mb: 1 }} />
          <Typography variant="subtitle2" gutterBottom>
            Auto-Mapped Entities
          </Typography>
          <Stack spacing={0.5} sx={{ mb: 1 }}>
            {withMappings.map((d) => (
              <Box
                key={d.entityId}
                sx={{ display: "flex", alignItems: "center", gap: 1 }}
              >
                <Typography variant="body2" sx={{ fontWeight: 500 }} noWrap>
                  {d.name}
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ ml: "auto" }}>
                  {d.autoMappings.map((m) => (
                    <Tooltip key={m.label} title={m.entity}>
                      <Chip
                        icon={<LinkIcon />}
                        label={m.label}
                        size="small"
                        variant="outlined"
                        sx={{ fontSize: "0.7rem", height: 20 }}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              </Box>
            ))}
          </Stack>
        </Collapse>
      </CardContent>
    </Card>
  );
};
