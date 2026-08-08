import type {
  DiagnosticBridgeInfo,
  DiagnosticEventType,
} from "@home-assistant-matter-hub/common";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import FilterListIcon from "@mui/icons-material/FilterList";
import TimelineIcon from "@mui/icons-material/Timeline";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDiagnostics } from "../../hooks/useDiagnostics.ts";

function contrastText(hex: string): string {
  const c = hex.replace("#", "");
  const r = Number.parseInt(c.substring(0, 2), 16) / 255;
  const g = Number.parseInt(c.substring(2, 4), 16) / 255;
  const b = Number.parseInt(c.substring(4, 6), 16) / 255;
  const luminance =
    0.2126 * (r <= 0.03928 ? r / 12.92 : ((r + 0.055) / 1.055) ** 2.4) +
    0.7152 * (g <= 0.03928 ? g / 12.92 : ((g + 0.055) / 1.055) ** 2.4) +
    0.0722 * (b <= 0.03928 ? b / 12.92 : ((b + 0.055) / 1.055) ** 2.4);
  return luminance > 0.179 ? "#000" : "#fff";
}

const eventTypeColors: Record<string, string> = {
  state_update: "#4caf50",
  command_received: "#2196f3",
  entity_error: "#f44336",
  session_opened: "#ff9800",
  session_closed: "#9e9e9e",
  subscription_changed: "#9c27b0",
  bridge_started: "#00bcd4",
  bridge_stopped: "#795548",
  entity_warning: "#ff9800",
};

const eventTypeLabelKeys: Record<string, string> = {
  state_update: "diagnostics.stateUpdate",
  command_received: "diagnostics.command",
  entity_error: "diagnostics.entityError",
  session_opened: "diagnostics.sessionOpen",
  session_closed: "diagnostics.sessionClose",
  subscription_changed: "diagnostics.subscription",
  bridge_started: "diagnostics.bridgeStart",
  bridge_stopped: "diagnostics.bridgeStop",
  entity_warning: "diagnostics.entityWarning",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

const allEventTypes = Object.keys(eventTypeColors) as DiagnosticEventType[];

export interface LiveEventLogProps {
  sortField?: "name" | "created";
  sortDirection?: "asc" | "desc";
}

export function LiveEventLog({
  sortField,
  sortDirection,
}: LiveEventLogProps = {}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { events, snapshot, connected, clearEvents } = useDiagnostics();
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(
    new Set(allEventTypes),
  );
  const [showFilters, setShowFilters] = useState(false);

  const toggleType = (type: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const filteredEvents = events.filter((e) => enabledTypes.has(e.type));

  const sortedBridges = useMemo(() => {
    const bridges = snapshot?.bridges ?? [];
    if (!sortField) return bridges;
    return [...bridges].sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.bridgeName.localeCompare(b.bridgeName);
      } else {
        cmp = a.bridgeId.localeCompare(b.bridgeId);
      }
      return sortDirection === "desc" ? -cmp : cmp;
    });
  }, [snapshot?.bridges, sortField, sortDirection]);

  const typeCounts: Record<string, number> = {};
  for (const e of events) {
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  }

  return (
    <Card>
      <CardContent>
        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          mb={2}
        >
          <Box display="flex" alignItems="center" gap={1}>
            <TimelineIcon />
            <Typography variant="h6">{t("diagnostics.title")}</Typography>
            <Chip
              icon={
                <FiberManualRecordIcon
                  sx={{
                    fontSize: 10,
                    color: connected
                      ? theme.palette.success.main
                      : theme.palette.error.main,
                  }}
                />
              }
              label={connected ? t("common.live") : t("common.offline")}
              size="small"
              variant="outlined"
            />
          </Box>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title={t("diagnostics.filterEvents")}>
              <IconButton
                size="small"
                onClick={() => setShowFilters((v) => !v)}
                color={showFilters ? "primary" : "default"}
              >
                <FilterListIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={t("diagnostics.clearEvents")}>
              <IconButton size="small" onClick={clearEvents}>
                <ClearAllIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        {/* Event type summary chips */}
        <Stack
          direction="row"
          spacing={0.5}
          flexWrap="wrap"
          sx={{ mb: 2, gap: 0.5 }}
        >
          {allEventTypes.map((type) => {
            const count = typeCounts[type] ?? 0;
            if (count === 0 && !showFilters) return null;
            const color = eventTypeColors[type];
            return (
              <Chip
                key={type}
                label={`${t(eventTypeLabelKeys[type])}: ${count}`}
                size="small"
                sx={{
                  bgcolor: enabledTypes.has(type)
                    ? color
                    : "action.disabledBackground",
                  color: enabledTypes.has(type)
                    ? contrastText(color)
                    : "text.disabled",
                  fontSize: "0.7rem",
                  height: 22,
                  cursor: "pointer",
                  opacity: enabledTypes.has(type) ? 1 : 0.5,
                }}
                onClick={() => toggleType(type)}
              />
            );
          })}
          {snapshot?.system && (
            <Chip
              label={`Total: ${snapshot.system.eventCount}`}
              size="small"
              variant="outlined"
              sx={{ fontSize: "0.7rem", height: 22 }}
            />
          )}
        </Stack>

        {/* Expandable filter panel */}
        <Collapse in={showFilters}>
          <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
            <Grid container spacing={0}>
              {allEventTypes.map((type) => {
                const color = eventTypeColors[type];
                return (
                  <Grid size={{ xs: 6, sm: 4, md: 3 }} key={type}>
                    <FormControlLabel
                      control={
                        <Checkbox
                          size="small"
                          checked={enabledTypes.has(type)}
                          onChange={() => toggleType(type)}
                          sx={{
                            color: color,
                            "&.Mui-checked": { color: color },
                          }}
                        />
                      }
                      label={
                        <Typography variant="caption">
                          {t(eventTypeLabelKeys[type])}
                        </Typography>
                      }
                    />
                  </Grid>
                );
              })}
            </Grid>
          </Paper>
        </Collapse>

        {/* Snapshot bridge overview */}
        {sortedBridges.length > 0 && (
          <>
            <Grid container spacing={1} sx={{ mb: 2 }}>
              {sortedBridges.map((bridge) => (
                <BridgeSnapshotCard key={bridge.bridgeId} bridge={bridge} />
              ))}
            </Grid>
            <Divider sx={{ mb: 2 }} />
          </>
        )}

        {/* Live event stream */}
        <Box
          sx={{
            maxHeight: 400,
            overflow: "auto",
            bgcolor: "background.default",
            borderRadius: 1,
            p: 1,
          }}
        >
          {filteredEvents.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: "center", py: 4 }}
            >
              {events.length === 0
                ? "Waiting for diagnostic events…"
                : t("diagnostics.noEvents")}
            </Typography>
          ) : (
            filteredEvents.map((event) => {
              const evtColor = eventTypeColors[event.type];
              return (
                <Box
                  key={event.id}
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    py: 0.4,
                    px: 0.5,
                    minWidth: 0,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    "&:hover": { bgcolor: "action.hover" },
                    "&:last-child": { borderBottom: "none" },
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      whiteSpace: "nowrap",
                      fontFamily: "monospace",
                      fontSize: "0.72rem",
                      minWidth: 85,
                      pt: 0.1,
                    }}
                  >
                    {formatTime(event.timestamp)}
                  </Typography>
                  <Chip
                    label={
                      eventTypeLabelKeys[event.type]
                        ? t(eventTypeLabelKeys[event.type])
                        : event.type
                    }
                    size="small"
                    sx={{
                      bgcolor: evtColor ?? "#757575",
                      color: contrastText(evtColor ?? "#757575"),
                      fontSize: "0.62rem",
                      fontWeight: 600,
                      height: 18,
                      minWidth: 90,
                    }}
                  />
                  {event.bridgeName && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "primary.main",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontSize: "0.72rem",
                        maxWidth: 140,
                        flexShrink: 0,
                      }}
                    >
                      [{event.bridgeName}]
                    </Typography>
                  )}
                  {event.entityId && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "warning.main",
                        fontFamily: "monospace",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontSize: "0.72rem",
                        maxWidth: 220,
                        flexShrink: 1,
                      }}
                    >
                      {event.entityId}
                    </Typography>
                  )}
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.primary",
                      flex: 1,
                      wordBreak: "break-word",
                      fontSize: "0.72rem",
                    }}
                  >
                    {event.message}
                  </Typography>
                </Box>
              );
            })
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

function BridgeSnapshotCard({ bridge }: { bridge: DiagnosticBridgeInfo }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Grid size={{ xs: 12, sm: 6 }}>
      <Paper
        variant="outlined"
        sx={{ p: 1.5, overflow: "hidden", minWidth: 0 }}
      >
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          sx={{ cursor: "pointer" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <Box sx={{ minWidth: 0, overflow: "hidden" }}>
            <Typography variant="body2" fontWeight={500} noWrap>
              {bridge.bridgeName}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap>
              {bridge.entityCount} devices · {bridge.sessionCount} sessions
            </Typography>
          </Box>
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            flexWrap="wrap"
            justifyContent="flex-end"
            sx={{ flexShrink: 0, ml: 1 }}
          >
            {Object.entries(bridge.featureFlags)
              .filter(([, v]) => v)
              .map(([k]) => (
                <Chip
                  key={k}
                  label={k
                    .replace(/^auto/, "")
                    .replace(/([A-Z])/g, " $1")
                    .trim()}
                  size="small"
                  variant="outlined"
                  sx={{ fontSize: "0.6rem", height: 18 }}
                />
              ))}
            <Chip
              label={bridge.status}
              size="small"
              color={
                bridge.status === "running"
                  ? "success"
                  : bridge.status === "failed"
                    ? "error"
                    : "default"
              }
              sx={{ height: 20 }}
            />
            <ExpandMoreIcon
              sx={{
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.2s",
                fontSize: 18,
                color: "text.secondary",
              }}
            />
          </Stack>
        </Box>
        <Collapse in={expanded}>
          <Box sx={{ mt: 1, maxHeight: 200, overflow: "auto" }}>
            {bridge.entities.map((entity) => (
              <Box
                key={entity.entityId}
                sx={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 0.5,
                  py: 0.3,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontFamily: "monospace",
                    fontSize: "0.68rem",
                    minWidth: 180,
                    flexShrink: 0,
                    color: entity.available ? "text.primary" : "error.main",
                  }}
                  noWrap
                >
                  {entity.entityId}
                </Typography>
                <Box display="flex" gap={0.3} flexWrap="wrap">
                  {entity.matterClusters.map((cluster) => (
                    <Chip
                      key={cluster}
                      label={cluster}
                      size="small"
                      variant="outlined"
                      sx={{
                        fontSize: "0.58rem",
                        height: 16,
                        "& .MuiChip-label": { px: 0.5 },
                      }}
                    />
                  ))}
                </Box>
              </Box>
            ))}
          </Box>
        </Collapse>
      </Paper>
    </Grid>
  );
}
