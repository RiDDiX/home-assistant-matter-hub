import type { BridgeFabric } from "@home-assistant-matter-hub/common";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import BugReportIcon from "@mui/icons-material/BugReport";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DevicesIcon from "@mui/icons-material/Devices";
import ErrorIcon from "@mui/icons-material/Error";
import MemoryIcon from "@mui/icons-material/Memory";
import RefreshIcon from "@mui/icons-material/Refresh";
import SortIcon from "@mui/icons-material/Sort";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BackupRestore } from "../backup/BackupRestore.tsx";
import { FabricIcon } from "../fabric/FabricIcon.tsx";
import { getVendorName } from "../fabric/vendor-names.ts";

type SortField = "name" | "created";
type SortDirection = "asc" | "desc";

interface BridgeHealthInfo {
  id: string;
  name: string;
  status: string;
  statusReason?: string;
  port: number;
  deviceCount: number;
  fabricCount: number;
  fabrics: Array<{
    fabricIndex: number;
    fabricId: number;
    nodeId: number;
    rootNodeId: number;
    label: string;
    rootVendorId: number;
  }>;
  failedEntityCount: number;
  connectivity?: {
    totalSessions: number;
    totalSubscriptions: number;
    sessions: Array<{
      id: number;
      peerNodeId: string;
      fabricIndex: number | null;
      subscriptionCount: number;
    }>;
    fabricSummary?: Array<{
      fabricIndex: number;
      sessions: number;
      subscriptions: number;
    }>;
  };
}

interface DetailedHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    homeAssistant: { connected: boolean };
    bridges: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
    };
  };
  bridgeDetails: BridgeHealthInfo[];
  recovery: {
    enabled: boolean;
    lastRecoveryAttempt?: string;
    recoveryCount: number;
  };
}

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export interface HealthDashboardProps {
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSortFieldChange?: (field: SortField) => void;
  onSortDirectionChange?: (dir: SortDirection) => void;
}

export function HealthDashboard(props: HealthDashboardProps = {}) {
  const { t } = useTranslation();
  const [health, setHealth] = useState<DetailedHealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [internalSortField, setInternalSortField] = useState<SortField>("name");
  const [internalSortDirection, setInternalSortDirection] =
    useState<SortDirection>("asc");

  const sortField = props.sortField ?? internalSortField;
  const sortDirection = props.sortDirection ?? internalSortDirection;
  const setSortField = props.onSortFieldChange ?? setInternalSortField;
  const setSortDirection =
    props.onSortDirectionChange ?? setInternalSortDirection;

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("api/health/detailed");
      if (res.ok) {
        const data = (await res.json()) as DetailedHealthStatus;
        setHealth(data);
        setError(null);
      } else {
        setError(t("health.fetchFailed"));
      }
    } catch {
      setError(t("health.connectionError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleDiagnosticExport = useCallback(async () => {
    try {
      const res = await fetch("api/diagnostic/export");
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const disposition = res.headers.get("Content-Disposition");
        const filename =
          disposition?.match(/filename="(.+)"/)?.[1] ??
          `hamh-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      setError(t("health.exportFailed"));
    }
  }, [t]);

  const handleRestart = async (bridgeId: string) => {
    try {
      await fetch(`api/matter/bridges/${bridgeId}/actions/restart`, {
        method: "POST",
      });
      fetchHealth();
    } catch {
      setError(t("health.restartFailed"));
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !health) {
    return (
      <Alert severity="error" sx={{ m: 2 }}>
        {error ?? t("health.unableToLoad")}
      </Alert>
    );
  }

  const statusIcon =
    health.status === "healthy" ? (
      <CheckCircleIcon color="success" />
    ) : health.status === "degraded" ? (
      <WarningIcon color="warning" />
    ) : (
      <ErrorIcon color="error" />
    );

  return (
    <Box sx={{ p: 2 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {statusIcon}
          <Typography variant="h5">{t("health.systemHealth")}</Typography>
          <Chip
            label={health.status.toUpperCase()}
            color={
              health.status === "healthy"
                ? "success"
                : health.status === "degraded"
                  ? "warning"
                  : "error"
            }
            size="small"
          />
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<BugReportIcon />}
            onClick={handleDiagnosticExport}
          >
            {t("health.exportDiagnostic")}
          </Button>
          <Tooltip title={t("common.refresh")}>
            <IconButton onClick={fetchHealth} aria-label="Refresh health data">
              <RefreshIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              {t("health.version")}
            </Typography>
            <Typography variant="h6">{health.version}</Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              {t("health.uptime")}
            </Typography>
            <Typography variant="h6">{formatUptime(health.uptime)}</Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">
              {t("health.homeAssistant")}
            </Typography>
            <Chip
              label={
                health.services.homeAssistant.connected
                  ? t("health.connected")
                  : t("health.disconnected")
              }
              color={
                health.services.homeAssistant.connected ? "success" : "error"
              }
              size="small"
            />
          </Paper>
        </Grid>
      </Grid>

      <Divider sx={{ my: 3 }} />

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <MemoryIcon />
          <Typography variant="h6">{t("health.bridgeStatus")}</Typography>
          <Chip
            label={`${health.services.bridges.running}/${health.services.bridges.total} ${t("common.running")}`}
            size="small"
            variant="outlined"
          />
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <SortIcon fontSize="small" color="action" />
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>{t("health.sortBy")}</InputLabel>
            <Select
              value={sortField}
              label={t("health.sortBy")}
              onChange={(e) => setSortField(e.target.value as SortField)}
            >
              <MenuItem value="name">{t("common.name")}</MenuItem>
              <MenuItem value="created">{t("health.created")}</MenuItem>
            </Select>
          </FormControl>
          <Tooltip
            title={
              sortDirection === "asc"
                ? t("health.ascending")
                : t("health.descending")
            }
          >
            <IconButton
              size="small"
              onClick={() =>
                setSortDirection(sortDirection === "asc" ? "desc" : "asc")
              }
              aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}
            >
              {sortDirection === "asc" ? (
                <ArrowUpwardIcon fontSize="small" />
              ) : (
                <ArrowDownwardIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Grid container spacing={2} sx={{ alignItems: "stretch" }}>
        {[...health.bridgeDetails]
          .sort((a, b) => {
            let cmp = 0;
            if (sortField === "name") {
              cmp = a.name.localeCompare(b.name);
            } else {
              cmp = a.id.localeCompare(b.id);
            }
            return sortDirection === "asc" ? cmp : -cmp;
          })
          .map((bridge) => (
            <Grid
              size={{ xs: 12, sm: 6, md: 6, lg: 4, xl: 3 }}
              key={bridge.id}
              sx={{ display: "flex" }}
            >
              <Card
                variant="outlined"
                sx={{
                  width: "100%",
                  height: "100%",
                  minWidth: 280,
                  maxWidth: 480,
                  display: "flex",
                  flexDirection: "column",
                  borderColor:
                    bridge.status === "running"
                      ? "success.main"
                      : bridge.status === "failed"
                        ? "error.main"
                        : "warning.main",
                }}
              >
                <CardContent
                  sx={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    p: 2,
                    "&:last-child": { pb: 2 },
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      flexShrink: 0,
                    }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 1,
                        minWidth: 0,
                      }}
                    >
                      <DevicesIcon />
                      <Typography
                        variant="subtitle1"
                        noWrap
                        sx={{ fontWeight: "bold", maxWidth: 140 }}
                      >
                        {bridge.name}
                      </Typography>
                    </Box>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                        flexShrink: 0,
                      }}
                    >
                      <Chip
                        label={bridge.status.toUpperCase()}
                        color={
                          bridge.status === "running"
                            ? "success"
                            : bridge.status === "failed"
                              ? "error"
                              : "warning"
                        }
                        size="small"
                      />
                      {bridge.status === "failed" && (
                        <Tooltip title={t("bridge.restart")}>
                          <IconButton
                            size="small"
                            onClick={() => handleRestart(bridge.id)}
                          >
                            <AutorenewIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </Box>

                  {bridge.statusReason && (
                    <Typography
                      variant="body2"
                      color="error"
                      sx={{ mt: 1, flexShrink: 0 }}
                    >
                      {bridge.statusReason}
                    </Typography>
                  )}

                  <Box sx={{ mt: "auto", pt: 1, flexShrink: 0 }}>
                    <Box
                      sx={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 0.5,
                        alignItems: "center",
                      }}
                    >
                      <Chip
                        label={`${t("common.port")} ${bridge.port}`}
                        size="small"
                        variant="outlined"
                        color="default"
                      />
                      <Chip
                        label={`${bridge.deviceCount} ${t("common.devices")}`}
                        size="small"
                        variant="outlined"
                        color="default"
                      />
                      <Chip
                        label={`${bridge.fabricCount} ${t("common.fabrics")}`}
                        size="small"
                        variant="outlined"
                        color="default"
                      />
                      {bridge.failedEntityCount > 0 && (
                        <Chip
                          label={`${bridge.failedEntityCount} failed`}
                          color="error"
                          size="small"
                        />
                      )}
                    </Box>
                  </Box>

                  {bridge.connectivity && bridge.status === "running" && (
                    <Box sx={{ mt: 1, flexShrink: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("health.sessions")}:{" "}
                        {bridge.connectivity.totalSessions} |{" "}
                        {t("health.subscriptions")}:{" "}
                        {bridge.connectivity.totalSubscriptions}
                        {bridge.connectivity.fabricSummary &&
                          bridge.connectivity.fabricSummary.length > 1 &&
                          ` (${bridge.connectivity.fabricSummary.length} ${t("health.fabrics")})`}
                      </Typography>
                    </Box>
                  )}

                  {bridge.fabrics.length > 0 && (
                    <Box sx={{ mt: 1, flexShrink: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("health.connectedTo")}:
                      </Typography>
                      <Box
                        sx={{
                          display: "flex",
                          gap: 0.5,
                          flexWrap: "wrap",
                          mt: 0.5,
                        }}
                      >
                        {bridge.fabrics.map((fabric) => (
                          <Tooltip
                            key={fabric.fabricIndex}
                            title={
                              <Box sx={{ fontSize: "0.75rem" }}>
                                <div>Fabric #{fabric.fabricIndex}</div>
                                <div>
                                  Vendor: {getVendorName(fabric.rootVendorId)}{" "}
                                  (0x
                                  {fabric.rootVendorId
                                    .toString(16)
                                    .toUpperCase()
                                    .padStart(4, "0")}
                                  )
                                </div>
                                <div>Fabric ID: {fabric.fabricId}</div>
                                <div>Node ID: {fabric.nodeId}</div>
                                <div>Root Node ID: {fabric.rootNodeId}</div>
                              </Box>
                            }
                          >
                            <Chip
                              icon={
                                <FabricIcon
                                  fabric={fabric as unknown as BridgeFabric}
                                />
                              }
                              label={
                                fabric.label ||
                                getVendorName(fabric.rootVendorId)
                              }
                              size="small"
                              variant="outlined"
                            />
                          </Tooltip>
                        ))}
                      </Box>
                    </Box>
                  )}
                </CardContent>
              </Card>
            </Grid>
          ))}
      </Grid>

      {health.recovery.enabled && (
        <>
          <Divider sx={{ my: 3 }} />
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1 }}>
            <AutorenewIcon />
            <Typography variant="h6">{t("health.autoRecovery")}</Typography>
            <Chip label={t("common.enabled")} color="success" size="small" />
          </Box>
          <Typography variant="body2" color="text.secondary">
            {t("health.recoveryAttempts")}: {health.recovery.recoveryCount}
            {health.recovery.lastRecoveryAttempt &&
              ` | Last attempt: ${new Date(health.recovery.lastRecoveryAttempt).toLocaleString()}`}
          </Typography>
        </>
      )}

      <Divider sx={{ my: 3 }} />
      <BackupRestore />
    </Box>
  );
}
