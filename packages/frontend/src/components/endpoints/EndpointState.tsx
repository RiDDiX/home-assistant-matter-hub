import {
  ClusterId,
  type EndpointData,
} from "@home-assistant-matter-hub/common";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LinkIcon from "@mui/icons-material/Link";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../misc/copy-text.ts";
import { useNotifications } from "../notifications/use-notifications.ts";

export interface EndpointStateProps {
  endpoint: EndpointData;
}

interface HaEntityDiag {
  entityId: string;
  haState: string;
  haAttributes: Record<string, unknown>;
  isUnavailable: boolean;
  mappings: LinkedEntity[];
  customName?: string;
  matterDeviceType?: string;
}

const ignoredBehaviors = [ClusterId.homeAssistantEntity];

// mapping fields that pull a second HA entity into this endpoint,
// labels are endpoints.linked.<field>
const LINKED_ENTITY_FIELDS = [
  "batteryEntity",
  "humidityEntity",
  "pressureEntity",
  "powerEntity",
  "energyEntity",
  "voltageEntity",
  "currentEntity",
  "batteryPowerEntity",
  "batteryEnergyEntity",
  "chargingSwitchEntity",
  "currentLimitEntity",
  "filterLifeEntity",
  "cleaningModeEntity",
  "suctionLevelEntity",
  "currentRoomEntity",
];

export interface LinkedEntity {
  field: string;
  entity: string;
}

export function linkedEntities(
  mapping: Record<string, unknown> | undefined,
): LinkedEntity[] {
  if (!mapping) return [];
  const result: LinkedEntity[] = [];
  for (const field of LINKED_ENTITY_FIELDS) {
    const entity = mapping[field];
    if (typeof entity === "string" && entity !== "") {
      result.push({ field, entity });
    }
  }
  const rooms = mapping.roomEntities;
  if (Array.isArray(rooms) && rooms.length > 0) {
    result.push({ field: "roomEntities", entity: rooms.join(", ") });
  }
  return result;
}

const extractHaDiagnostics = (
  state: Record<string, unknown>,
): HaEntityDiag | null => {
  const ha = state.homeAssistantEntity as
    | {
        entity?: {
          entity_id?: string;
          state?: { state?: string; attributes?: Record<string, unknown> };
        };
        mapping?: Record<string, unknown>;
        customName?: string;
      }
    | undefined;

  if (!ha?.entity?.entity_id) return null;

  const entityId = ha.entity.entity_id;
  const haState = ha.entity.state?.state ?? "unknown";
  const haAttributes = ha.entity.state?.attributes ?? {};
  const isUnavailable = haState === "unavailable" || haState === "unknown";

  const mapping = ha.mapping;
  const mappings = linkedEntities(mapping);

  return {
    entityId,
    haState,
    haAttributes,
    isUnavailable,
    mappings,
    customName: ha.customName as string | undefined,
    matterDeviceType:
      typeof mapping?.matterDeviceType === "string"
        ? mapping.matterDeviceType
        : undefined,
  };
};

const EntityDiagnosticsPanel = ({ endpoint }: { endpoint: EndpointData }) => {
  const { t } = useTranslation();
  const diag = useMemo(
    () => extractHaDiagnostics(endpoint.state as Record<string, unknown>),
    [endpoint.state],
  );

  if (!diag) return null;

  const importantAttrs = [
    "device_class",
    "supported_features",
    "supported_color_modes",
    "color_mode",
    "brightness",
    "color_temp",
    "hvac_modes",
    "hvac_mode",
    "hvac_action",
    "current_temperature",
    "temperature",
    "fan_speed",
    "fan_speed_list",
    "volume_level",
    "is_volume_muted",
    "source",
    "source_list",
    "current_position",
    "current_tilt_position",
    "battery_level",
    "unit_of_measurement",
    "state_class",
  ];

  const relevantAttrs = Object.entries(diag.haAttributes).filter(
    ([key]) => importantAttrs.includes(key) || key === "friendly_name",
  );

  return (
    <Paper
      sx={{ p: 2, mb: 2, bgcolor: "background.default" }}
      variant="outlined"
    >
      <Stack spacing={1.5}>
        <Box display="flex" alignItems="center" gap={1}>
          <Typography variant="subtitle2" fontWeight={600}>
            {t("endpoints.homeAssistantEntity")}
          </Typography>
          {diag.isUnavailable ? (
            <Chip
              icon={<WarningAmberIcon />}
              label={diag.haState}
              size="small"
              color="warning"
              variant="outlined"
            />
          ) : (
            <Chip
              icon={<CheckCircleIcon />}
              label={diag.haState}
              size="small"
              color="success"
              variant="outlined"
            />
          )}
        </Box>

        <TableContainer>
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ fontWeight: 500, width: "35%" }}>
                  {t("endpoints.entityId")}
                </TableCell>
                <TableCell>
                  <Typography fontFamily="monospace" fontSize="0.85em">
                    {diag.entityId}
                  </Typography>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ fontWeight: 500 }}>
                  {t("endpoints.haState")}
                </TableCell>
                <TableCell>
                  <Typography fontFamily="monospace" fontSize="0.85em">
                    {diag.haState}
                  </Typography>
                </TableCell>
              </TableRow>
              {diag.customName && (
                <TableRow>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {t("endpoints.customName")}
                  </TableCell>
                  <TableCell>{diag.customName}</TableCell>
                </TableRow>
              )}
              {diag.matterDeviceType && (
                <TableRow>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {t("endpoints.deviceTypeOverride")}
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={diag.matterDeviceType}
                      size="small"
                      variant="outlined"
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {relevantAttrs.length > 0 && (
          <>
            <Divider />
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
            >
              {t("endpoints.keyHaAttributes")}
            </Typography>
            <TableContainer>
              <Table size="small">
                <TableBody>
                  {relevantAttrs.map(([key, value]) => (
                    <TableRow key={key}>
                      <TableCell
                        sx={{
                          fontWeight: 500,
                          width: "35%",
                          fontSize: "0.8em",
                        }}
                      >
                        {key}
                      </TableCell>
                      <TableCell>
                        <Typography
                          fontFamily="monospace"
                          fontSize="0.8em"
                          sx={{ wordBreak: "break-all" }}
                        >
                          {typeof value === "object"
                            ? JSON.stringify(value)
                            : String(value)}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        {diag.mappings.length > 0 && (
          <>
            <Divider />
            <Typography
              variant="caption"
              color="text.secondary"
              fontWeight={600}
            >
              {t("endpoints.entityMappings")}
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {diag.mappings.map((m) => (
                <Tooltip key={m.field} title={m.entity}>
                  <Chip
                    icon={<LinkIcon />}
                    label={`${t(`endpoints.linked.${m.field}`)}: ${m.entity}`}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: "0.75rem" }}
                  />
                </Tooltip>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
};

const autoMappedClusterNames: Record<string, string> = {
  powerSource: "batteryEntity",
  relativeHumidityMeasurement: "humidityEntity",
  pressureMeasurement: "pressureEntity",
  electricalPowerMeasurement: "powerEntity",
  electricalEnergyMeasurement: "energyEntity",
};

export const EndpointState = (props: EndpointStateProps) => {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const allBehaviors = useMemo(
    () =>
      Object.keys(
        props.endpoint.state,
      ) as (keyof typeof props.endpoint.state)[],
    [props.endpoint],
  );
  const behaviors = useMemo(
    () => allBehaviors.filter((it) => !ignoredBehaviors.includes(it)).sort(),
    [allBehaviors],
  );

  const autoMappedClusters = useMemo(() => {
    const diag = extractHaDiagnostics(
      props.endpoint.state as Record<string, unknown>,
    );
    if (!diag) return new Set<string>();
    const set = new Set<string>();
    for (const m of diag.mappings) {
      for (const [cluster, field] of Object.entries(autoMappedClusterNames)) {
        if (field === m.field) {
          set.add(cluster);
        }
      }
    }
    return set;
  }, [props.endpoint.state]);

  const metadata = useMemo(
    () => ({
      [t("endpoints.endpointId")]: props.endpoint.id.local,
      [t("endpoints.endpointType")]:
        `${props.endpoint.type.name} (${props.endpoint.type.id})`,
      [t("endpoints.endpointNumber")]: props.endpoint.endpoint,
      [t("endpoints.childEndpoints")]: props.endpoint.parts.length,
    }),
    [props.endpoint, t],
  );

  return (
    <>
      <EntityDiagnosticsPanel endpoint={props.endpoint} />

      <Paper sx={{ p: 2, mb: 2 }} variant="outlined">
        <Stack spacing={2}>
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
          >
            <Typography component="span">
              {t("endpoints.aboutEndpoint")}
            </Typography>
            <Button
              onClick={async () => {
                const ok = await copyText(
                  JSON.stringify(props.endpoint, null, 2),
                );
                notifications.show(
                  ok
                    ? { message: t("common.copied"), severity: "success" }
                    : { message: t("common.copyFailed"), severity: "error" },
                );
              }}
              variant="outlined"
              size="small"
            >
              {t("endpoints.copyData")}
            </Button>
          </Stack>
          <ObjectTable value={metadata} hideHead></ObjectTable>
        </Stack>
      </Paper>

      {behaviors.map((behavior) => {
        const isAutoMapped = autoMappedClusters.has(behavior);
        return (
          <Accordion key={behavior}>
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              aria-controls="panel1-content"
            >
              <Box display="flex" alignItems="center" gap={1}>
                <Typography component="span">
                  {t("endpoints.behavior")}: <strong>{behavior}</strong>
                </Typography>
                {isAutoMapped && (
                  <Chip
                    icon={<LinkIcon />}
                    label={t("endpoints.autoMapped")}
                    size="small"
                    color="info"
                    variant="outlined"
                    sx={{ fontSize: "0.7rem", height: 20 }}
                  />
                )}
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <ObjectTable value={props.endpoint.state[behavior]} />
            </AccordionDetails>
          </Accordion>
        );
      })}
    </>
  );
};

const ObjectTable = <T extends object>(props: {
  value: T;
  hideHead?: boolean;
}) => {
  const { t } = useTranslation();
  const properties = useMemo(
    () => Object.keys(props.value) as (keyof T & string)[],
    [props.value],
  );
  return (
    <TableContainer>
      <Table size="small">
        {!props.hideHead && (
          <TableHead>
            <TableRow>
              <TableCell>{t("common.property")}</TableCell>
              <TableCell>{t("common.value")}</TableCell>
            </TableRow>
          </TableHead>
        )}
        <TableBody>
          {properties.map((property) => (
            <TableRow key={property}>
              <TableCell>{property}</TableCell>
              <TableCell>
                <RenderProperty property={props.value[property]} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

const RenderProperty = (props: { property: unknown }) => {
  const value = useMemo(() => {
    if (typeof props.property === "string") {
      return props.property.toString();
    } else if (typeof props.property === "number") {
      return props.property.toString();
    } else if (typeof props.property === "boolean") {
      return String(props.property);
    } else {
      return JSON.stringify(props.property);
    }
  }, [props.property]);
  return (
    <Typography fontFamily="monospace" fontSize="0.9em">
      {value}
    </Typography>
  );
};
