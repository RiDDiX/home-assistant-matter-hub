import AccountTreeIcon from "@mui/icons-material/AccountTree";
import AddIcon from "@mui/icons-material/Add";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CloseIcon from "@mui/icons-material/Close";
import DevicesIcon from "@mui/icons-material/Devices";
import ErrorIcon from "@mui/icons-material/Error";
import HomeIcon from "@mui/icons-material/Home";
import HubIcon from "@mui/icons-material/Hub";
import LabelIcon from "@mui/icons-material/Label";
import LinkIcon from "@mui/icons-material/Link";
import LockIcon from "@mui/icons-material/Lock";
import MapIcon from "@mui/icons-material/Map";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import SettingsIcon from "@mui/icons-material/Settings";
import StopIcon from "@mui/icons-material/Stop";
import TuneIcon from "@mui/icons-material/Tune";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  checkBridgeIconExists,
  getBridgeIconUrl,
} from "../../api/bridge-icons.ts";
import {
  restartAllBridges,
  startAllBridges,
  stopAllBridges,
} from "../../api/bridges.ts";
import {
  getBridgeIcon,
  getBridgeIconColor,
} from "../../components/bridge/bridgeIconUtils.ts";
import { Wizard } from "../../components/Wizard.tsx";
import { useBridges } from "../../hooks/data/bridges.ts";
import { useDashboardWidgets } from "../../hooks/use-dashboard-widgets.ts";
import { navigation } from "../../routes.tsx";
import { loadBridges } from "../../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../../state/hooks.ts";
import { DashboardCustomizeDialog } from "./DashboardCustomizeDialog.tsx";

interface HealthSummary {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime: number;
  services: {
    homeAssistant: { connected: boolean };
    bridges: {
      total: number;
      running: number;
      stopped: number;
      failed: number;
    };
  };
  bridgeDetails: Array<{
    id: string;
    name: string;
    status: string;
    deviceCount: number;
    fabricCount: number;
    failedEntityCount: number;
    priority: number;
  }>;
}

const formatUptime = (seconds: number): string => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

function StatCard({
  value,
  icon,
  // color,
  subtitle,
  onClick,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  subtitle?: React.ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <CardContent sx={{ py: 2, "&:last-child": { pb: 2 } }}>
      <Box
        sx={{
          display: "flex",
          flexDirection: { xs: "column", sm: "row" },
          alignItems: "center",
          gap: { xs: 2, sm: 3 },
          textAlign: { xs: "center", sm: "left" },
        }}
      >
        {icon}
        <Box sx={{ minWidth: 0 }}>
          <Typography
            noWrap
            sx={{
              fontWeight: 700,
              lineHeight: 1.1,
              fontSize: { xs: "1.5rem", sm: "2.125rem" },
            }}
          >
            {value}
          </Typography>
          <Typography
            noWrap
            sx={{
              fontWeight: 700,
              lineHeight: 1.2,
              fontSize: { xs: "1.2rem", sm: "1.5rem" },
            }}
          >
            {subtitle}
          </Typography>
        </Box>
      </Box>
    </CardContent>
  );

  return (
    <Card variant="outlined" sx={{ height: "100%" }}>
      {onClick ? (
        <CardActionArea onClick={onClick} sx={{ height: "100%" }}>
          {content}
        </CardActionArea>
      ) : (
        content
      )}
    </Card>
  );
}

function BridgeMiniCard({
  bridge,
  order,
  onClick,
}: {
  bridge: HealthSummary["bridgeDetails"][0];
  order: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const { content: bridges } = useBridges();
  const bridgeData = bridges?.find((b) => b.id === bridge.id);
  const [hasCustomIcon, setHasCustomIcon] = useState(false);

  useEffect(() => {
    checkBridgeIconExists(bridge.id).then(setHasCustomIcon);
  }, [bridge.id]);

  const statusColor =
    bridge.status === "running"
      ? "success"
      : bridge.status === "failed"
        ? "error"
        : "default";

  return (
    <Card variant="outlined">
      <CardActionArea onClick={onClick}>
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Chip
              label={`#${order}`}
              size="small"
              color="primary"
              variant="outlined"
              sx={{
                minWidth: 28,
                height: 22,
                fontSize: "0.65rem",
                fontWeight: "bold",
                flexShrink: 0,
              }}
            />
            {hasCustomIcon ? (
              <Box
                component="img"
                src={getBridgeIconUrl(bridge.id)}
                alt={bridge.name}
                sx={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  objectFit: "cover",
                }}
              />
            ) : (
              bridgeData && (
                <Avatar
                  sx={{
                    bgcolor: getBridgeIconColor(bridgeData),
                    width: 36,
                    height: 36,
                  }}
                >
                  {(() => {
                    const Icon = getBridgeIcon(bridgeData);
                    return <Icon sx={{ fontSize: 20 }} />;
                  })()}
                </Avatar>
              )
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle2" noWrap>
                {bridge.name}
              </Typography>
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ alignItems: "center" }}
              >
                <Chip
                  label={bridge.status}
                  size="small"
                  color={statusColor}
                  sx={{ height: 18, fontSize: "0.65rem" }}
                />
                <Typography variant="caption" color="text.secondary">
                  {bridge.deviceCount} {t("common.devices").toLowerCase()}
                </Typography>
                {bridge.fabricCount > 0 && (
                  <Typography variant="caption" color="text.secondary">
                    · {bridge.fabricCount} {t("common.fabrics").toLowerCase()}
                  </Typography>
                )}
              </Stack>
            </Box>
            {bridge.failedEntityCount > 0 && (
              <Chip
                icon={<WarningIcon sx={{ fontSize: 14 }} />}
                label={bridge.failedEntityCount}
                size="small"
                color="warning"
                variant="outlined"
                sx={{ height: 22 }}
              />
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function NavCard({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Card variant="outlined">
      <CardActionArea onClick={onClick}>
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar
              sx={{
                bgcolor: "action.selected",
                color: "text.secondary",
                width: 36,
                height: 36,
              }}
            >
              {icon}
            </Avatar>
            <Typography variant="subtitle2">{title}</Typography>
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export const DashboardPage = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState(false);
  const bulkGuard = useRef(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const widgets = useDashboardWidgets();
  const [successDismissed, setSuccessDismissed] = useState(
    () => localStorage.getItem("hamh-first-success-dismissed") === "true",
  );

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("api/health/detailed");
      if (res.ok) {
        setHealth(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 15000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const totalDevices = useMemo(
    () => health?.bridgeDetails.reduce((sum, b) => sum + b.deviceCount, 0) ?? 0,
    [health],
  );

  const totalFabrics = useMemo(() => {
    if (!health?.bridgeDetails) return 0;
    return health.bridgeDetails.reduce((sum, b) => sum + b.fabricCount, 0);
  }, [health]);

  const totalFailed = useMemo(
    () =>
      health?.bridgeDetails.reduce((sum, b) => sum + b.failedEntityCount, 0) ??
      0,
    [health],
  );

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const bridges = health?.services.bridges;
  const haConnected = health?.services.homeAssistant.connected ?? false;
  const hasBridges = (bridges?.total ?? 0) > 0;

  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 3 }}>
        <HomeIcon color="primary" fontSize="large" />
        <Typography variant="h5" sx={{ fontWeight: 600 }} component="h1">
          {t("dashboard.title")}
        </Typography>
        {hasBridges && (
          <IconButton
            size="small"
            onClick={() => setCustomizeOpen(true)}
            sx={{ ml: "auto" }}
            title={t("dashboard.customizeDashboard")}
          >
            <TuneIcon />
          </IconButton>
        )}
      </Box>

      {hasBridges && totalFabrics > 0 && !successDismissed && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          action={
            <IconButton
              size="small"
              color="inherit"
              onClick={() => {
                setSuccessDismissed(true);
                localStorage.setItem("hamh-first-success-dismissed", "true");
              }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          {t("dashboard.successMessage", { count: totalFabrics })}
        </Alert>
      )}

      {!hasBridges && !loading && (
        <Card
          sx={{
            mb: 3,
            background: (t) =>
              `linear-gradient(135deg, ${t.palette.primary.dark}15, ${t.palette.secondary.dark}15)`,
            border: "1px solid",
            borderColor: "divider",
          }}
        >
          <CardContent sx={{ textAlign: "center", py: 5, px: 3 }}>
            <HubIcon sx={{ fontSize: 56, color: "primary.main", mb: 2 }} />
            <Typography variant="h5" sx={{ fontWeight: 600 }} gutterBottom>
              {t("dashboard.welcome")}
            </Typography>
            <Typography
              variant="body1"
              color="text.secondary"
              sx={{ maxWidth: 520, mx: "auto", mb: 4 }}
            >
              {t("dashboard.welcomeDescription")}
            </Typography>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={2}
              sx={{ justifyContent: "center", mb: 3 }}
            >
              <Button
                variant="contained"
                size="large"
                startIcon={<AutoFixHighIcon />}
                onClick={() => setWizardOpen(true)}
              >
                {t("dashboard.openWizard")}
              </Button>
              <Button
                variant="outlined"
                size="large"
                startIcon={<MapIcon />}
                onClick={() => navigate(navigation.areaSetup)}
              >
                {t("dashboard.setupByArea")}
              </Button>
              <Button
                variant="outlined"
                size="large"
                startIcon={<AddIcon />}
                onClick={() => navigate(navigation.createBridge)}
              >
                {t("dashboard.manualSetup")}
              </Button>
            </Stack>
            <Button
              size="small"
              endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
              href="https://t0bst4r.github.io/home-assistant-matter-hub/"
              target="_blank"
              rel="noopener"
            >
              {t("dashboard.documentation")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Customizable widget sections */}
      {hasBridges &&
        widgets.visibleWidgets.map((widgetId, idx) => (
          <Box key={widgetId}>
            {idx > 0 && <Divider sx={{ my: 3 }} />}

            {widgetId === "stats" && (
              <Grid container spacing={2} sx={{ mb: 3 }}>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <StatCard
                    title={t("nav.bridges")}
                    value={bridges?.total ?? 0}
                    icon={<HubIcon />}
                    color={theme.palette.success.main}
                    subtitle={
                      bridges
                        ? `${bridges.running} running${bridges.failed > 0 ? ` · ${bridges.failed} failed` : ""}`
                        : undefined
                    }
                    onClick={() => navigate(navigation.bridges)}
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <StatCard
                    title={t("common.devices")}
                    value={totalDevices}
                    icon={<DevicesIcon />}
                    color={theme.palette.primary.main}
                    subtitle={
                      totalFailed > 0 ? (
                        <Chip
                          icon={<WarningIcon sx={{ fontSize: 14 }} />}
                          label={`${totalFailed} failed`}
                          size="small"
                          color="warning"
                          variant="outlined"
                          clickable
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`${navigation.devices}?showFailed=true`);
                          }}
                          sx={{ height: 22, fontSize: "0.7rem" }}
                        />
                      ) : undefined
                    }
                    onClick={() => navigate(navigation.devices)}
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <StatCard
                    title={t("common.fabrics")}
                    value={totalFabrics}
                    icon={<LinkIcon />}
                    color={theme.palette.secondary.main}
                    onClick={() => navigate(navigation.networkMap)}
                  />
                </Grid>
                <Grid size={{ xs: 6, sm: 3 }}>
                  <StatCard
                    title={t("dashboard.haConnection")}
                    value={
                      haConnected ? t("common.online") : t("common.offline")
                    }
                    icon={haConnected ? <CheckCircleIcon /> : <ErrorIcon />}
                    color={
                      haConnected
                        ? theme.palette.success.main
                        : theme.palette.error.main
                    }
                    subtitle={
                      health?.uptime != null
                        ? `${t("health.uptime")} ${formatUptime(health.uptime)}`
                        : undefined
                    }
                  />
                </Grid>
              </Grid>
            )}

            {widgetId === "bridges" && (
              <>
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
                  <Typography variant="h6">{t("nav.bridges")}</Typography>
                </Box>

                <Stack
                  direction="row"
                  spacing={1.5}
                  sx={{ mb: 2, flexWrap: "wrap" }}
                  useFlexGap
                >
                  <Button
                    variant="contained"
                    startIcon={<AutoFixHighIcon />}
                    onClick={() => setWizardOpen(true)}
                    size="large"
                  >
                    {t("dashboard.bridgeWizard")}
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<AddIcon />}
                    onClick={() => navigate(navigation.createBridge)}
                    size="large"
                  >
                    {t("dashboard.createBridge")}
                  </Button>
                  <Button
                    variant="outlined"
                    startIcon={<MapIcon />}
                    onClick={() => navigate(navigation.areaSetup)}
                    size="large"
                  >
                    {t("dashboard.areaSetup")}
                  </Button>
                  <Divider orientation="vertical" flexItem />
                  <Button
                    variant="outlined"
                    color="success"
                    startIcon={<PlayArrowIcon />}
                    disabled={bulkAction}
                    onClick={async () => {
                      if (bulkGuard.current) return;
                      bulkGuard.current = true;
                      setBulkAction(true);
                      try {
                        await startAllBridges();
                        await fetchHealth();
                      } finally {
                        setBulkAction(false);
                        bulkGuard.current = false;
                      }
                    }}
                  >
                    {t("dashboard.startAll")}
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<StopIcon />}
                    disabled={bulkAction}
                    onClick={async () => {
                      if (bulkGuard.current) return;
                      bulkGuard.current = true;
                      setBulkAction(true);
                      try {
                        await stopAllBridges();
                        await fetchHealth();
                      } finally {
                        setBulkAction(false);
                        bulkGuard.current = false;
                      }
                    }}
                  >
                    {t("dashboard.stopAll")}
                  </Button>
                  <Button
                    variant="outlined"
                    color="warning"
                    startIcon={<RestartAltIcon />}
                    disabled={bulkAction}
                    onClick={async () => {
                      if (bulkGuard.current) return;
                      bulkGuard.current = true;
                      setBulkAction(true);
                      try {
                        await restartAllBridges();
                        await fetchHealth();
                      } finally {
                        setBulkAction(false);
                        bulkGuard.current = false;
                      }
                    }}
                  >
                    {t("dashboard.restartAll")}
                  </Button>
                </Stack>

                {health?.bridgeDetails && health.bridgeDetails.length > 0 ? (
                  <Grid container spacing={1.5}>
                    {[...health.bridgeDetails]
                      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
                      .map((bridge, idx) => (
                        <Grid key={bridge.id} size={{ xs: 12, sm: 6, md: 4 }}>
                          <BridgeMiniCard
                            bridge={bridge}
                            order={idx + 1}
                            onClick={() =>
                              navigate(navigation.bridge(bridge.id))
                            }
                          />
                        </Grid>
                      ))}
                  </Grid>
                ) : (
                  <Card variant="outlined">
                    <CardContent sx={{ textAlign: "center", py: 4 }}>
                      <Typography color="text.secondary">
                        {t("dashboard.noBridgesHint")}
                      </Typography>
                    </CardContent>
                  </Card>
                )}
              </>
            )}

            {widgetId === "quickNav" && (
              <>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  {t("dashboard.quickNavigation")}
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("nav.bridges")}
                      icon={<HubIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.bridges)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("dashboard.areaSetup")}
                      icon={<MapIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.areaSetup)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("nav.devices")}
                      icon={<DevicesIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.devices)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("nav.networkMap")}
                      icon={<AccountTreeIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.networkMap)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("nav.health")}
                      icon={<MonitorHeartIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.health)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("dashboard.startupOrder")}
                      icon={<RocketLaunchIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.startup)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("dashboard.lockCredentials")}
                      icon={<LockIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.lockCredentials)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("dashboard.filterReference")}
                      icon={<LabelIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.labels)}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6, md: 4 }}>
                    <NavCard
                      title={t("nav.settings")}
                      icon={<SettingsIcon sx={{ fontSize: 20 }} />}
                      onClick={() => navigate(navigation.settings)}
                    />
                  </Grid>
                </Grid>
              </>
            )}
          </Box>
        ))}

      <DashboardCustomizeDialog
        open={customizeOpen}
        config={widgets.config}
        onToggle={widgets.toggleWidget}
        onMove={widgets.moveWidget}
        onReset={widgets.resetToDefaults}
        onClose={() => setCustomizeOpen(false)}
      />

      <Wizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={() => {
          dispatch(loadBridges());
          fetchHealth();
        }}
      />
    </Box>
  );
};
