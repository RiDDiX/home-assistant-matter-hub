import {
  type BridgeFeatureFlags,
  type ControllerProfile,
  type CreateBridgeRequest,
  controllerProfiles,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { createBridge } from "../../api/bridges.js";
import { Breadcrumbs } from "../../components/breadcrumbs/Breadcrumbs.tsx";
import { useNotifications } from "../../components/notifications/use-notifications.ts";
import { navigation } from "../../routes.tsx";
import { loadBridges } from "../../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../../state/hooks.ts";

interface AreaSummary {
  area_id: string;
  name: string;
  entityCount: number;
  domains: Record<string, number>;
}

const controllerIcons: Record<string, string> = {
  apple_home: "\uD83C\uDF4F",
  google_home: "\uD83C\uDFE0",
  alexa: "\uD83D\uDD35",
  multi_controller: "\uD83D\uDD00",
};

const domainIcons: Record<string, string> = {
  light: "\uD83D\uDCA1",
  switch: "\uD83D\uDD0C",
  sensor: "\uD83D\uDCCA",
  binary_sensor: "\uD83D\uDCCA",
  climate: "\uD83C\uDF21\uFE0F",
  cover: "\uD83E\uDE9F",
  fan: "\uD83C\uDF2C\uFE0F",
  lock: "\uD83D\uDD12",
  media_player: "\uD83C\uDFB5",
  vacuum: "\uD83E\uDD16",
  valve: "\uD83D\uDEB0",
  humidifier: "\uD83D\uDCA7",
};

export const AreaBridgeSetupPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notifications = useNotifications();
  const dispatch = useAppDispatch();

  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAreas, setSelectedAreas] = useState<Set<string>>(new Set());
  const [selectedController, setSelectedController] = useState<
    ControllerProfile | undefined
  >();
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<
    Array<{ area: string; success: boolean; error?: string }>
  >([]);

  useEffect(() => {
    const fetchAreas = async () => {
      try {
        const res = await fetch("api/matter/areas/summary");
        if (res.ok) {
          const data = (await res.json()) as AreaSummary[];
          setAreas(data.filter((a) => a.entityCount > 0));
        }
      } catch {
        notifications.show({
          message: t("areaSetup.loadFailed"),
          severity: "error",
        });
      } finally {
        setLoading(false);
      }
    };
    fetchAreas();
  }, [notifications, t]);

  const toggleArea = useCallback((areaId: string) => {
    setSelectedAreas((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) {
        next.delete(areaId);
      } else {
        next.add(areaId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedAreas(new Set(areas.map((a) => a.area_id)));
  }, [areas]);

  const selectNone = useCallback(() => {
    setSelectedAreas(new Set());
  }, []);

  const handleCreate = useCallback(async () => {
    if (selectedAreas.size === 0) return;

    setCreating(true);
    setProgress(0);
    setResults([]);

    const areasToCreate = areas.filter((a) => selectedAreas.has(a.area_id));
    const newResults: Array<{
      area: string;
      success: boolean;
      error?: string;
    }> = [];

    let nextPortRes: { port: number } | undefined;
    try {
      const res = await fetch("api/matter/next-port");
      if (res.ok) {
        nextPortRes = (await res.json()) as { port: number };
      }
    } catch {
      // Use default
    }
    let port = nextPortRes?.port ?? 5540;

    for (let i = 0; i < areasToCreate.length; i++) {
      const area = areasToCreate[i];
      setProgress(((i + 1) / areasToCreate.length) * 100);

      const featureFlags: BridgeFeatureFlags = {
        autoBatteryMapping: true,
        autoHumidityMapping: true,
        autoPressureMapping: true,
        ...(selectedController?.featureFlags ?? {}),
      };

      const request: CreateBridgeRequest = {
        name: area.name,
        port: port++,
        filter: {
          include: [
            {
              type: HomeAssistantMatcherType.Area,
              value: area.area_id,
            },
          ],
          exclude: [],
        },
        featureFlags,
      };

      try {
        await createBridge(request);
        newResults.push({ area: area.name, success: true });
      } catch (e) {
        newResults.push({
          area: area.name,
          success: false,
          error: e instanceof Error ? e.message : t("areaSetup.unknownError"),
        });
      }
    }

    setResults(newResults);
    setCreating(false);
    dispatch(loadBridges());

    const succeeded = newResults.filter((r) => r.success).length;
    const failed = newResults.filter((r) => !r.success).length;
    if (failed === 0) {
      notifications.show({
        message: t("areaSetup.createdSuccess", { count: succeeded }),
        severity: "success",
      });
    } else {
      notifications.show({
        message: t("areaSetup.createdPartial", { succeeded, failed }),
        severity: "warning",
      });
    }
  }, [selectedAreas, areas, selectedController, dispatch, notifications, t]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs
        items={[
          { name: t("nav.bridges"), to: navigation.bridges },
          { name: t("areaSetup.title"), to: navigation.areaSetup },
        ]}
      />

      <Typography variant="h5">{t("areaSetup.heading")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t("areaSetup.description")}
      </Typography>

      {areas.length === 0 ? (
        <Alert severity="info">{t("areaSetup.noAreas")}</Alert>
      ) : (
        <>
          {/* Controller Selection */}
          <Box>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              {t("areaSetup.selectController")}
            </Typography>
            <Grid container spacing={1.5}>
              {controllerProfiles.map((profile) => {
                const isSelected = selectedController?.id === profile.id;
                return (
                  <Grid key={profile.id} size={{ xs: 6, sm: 3 }}>
                    <Card
                      variant="outlined"
                      sx={{
                        borderColor: isSelected ? "primary.main" : "divider",
                        borderWidth: isSelected ? 2 : 1,
                        bgcolor: isSelected
                          ? "action.selected"
                          : "background.paper",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <CardActionArea
                        onClick={() =>
                          setSelectedController(
                            isSelected ? undefined : profile,
                          )
                        }
                      >
                        <CardContent
                          sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}
                        >
                          <Box display="flex" alignItems="center" gap={0.5}>
                            <Typography fontSize={18}>
                              {controllerIcons[profile.id] ?? "\uD83C\uDFE0"}
                            </Typography>
                            <Typography variant="body2" fontWeight={500}>
                              {profile.name}
                            </Typography>
                            {isSelected && (
                              <CheckCircleIcon
                                color="primary"
                                sx={{ fontSize: 16, ml: "auto" }}
                              />
                            )}
                          </Box>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          </Box>

          {/* Area Selection */}
          <Box>
            <Box
              display="flex"
              alignItems="center"
              justifyContent="space-between"
              mb={1}
            >
              <Typography variant="subtitle1" fontWeight={600}>
                {t("areaSetup.selectAreas", {
                  selected: selectedAreas.size,
                  total: areas.length,
                })}
              </Typography>
              <Box display="flex" gap={1}>
                <Button size="small" onClick={selectAll}>
                  {t("common.all")}
                </Button>
                <Button size="small" onClick={selectNone}>
                  {t("areaSetup.clear")}
                </Button>
              </Box>
            </Box>
            <Grid container spacing={1}>
              {areas.map((area) => {
                const isSelected = selectedAreas.has(area.area_id);
                const topDomains = Object.entries(area.domains)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 4);

                return (
                  <Grid key={area.area_id} size={{ xs: 12, sm: 6, md: 4 }}>
                    <Card
                      variant="outlined"
                      sx={{
                        borderColor: isSelected ? "primary.main" : "divider",
                        borderWidth: isSelected ? 2 : 1,
                        bgcolor: isSelected
                          ? "action.selected"
                          : "background.paper",
                        transition: "all 0.15s ease",
                      }}
                    >
                      <CardActionArea
                        onClick={() => toggleArea(area.area_id)}
                        sx={{
                          p: 0,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          justifyContent: "flex-start",
                        }}
                      >
                        <CardContent
                          sx={{
                            p: 1.5,
                            "&:last-child": { pb: 1.5 },
                            width: "100%",
                          }}
                        >
                          <Box display="flex" alignItems="center" gap={1}>
                            <FormControlLabel
                              control={
                                <Checkbox
                                  checked={isSelected}
                                  size="small"
                                  sx={{ p: 0.5 }}
                                />
                              }
                              label=""
                              sx={{ m: 0, mr: -0.5 }}
                            />
                            <Typography
                              variant="subtitle2"
                              sx={{ flexGrow: 1 }}
                            >
                              {area.name}
                            </Typography>
                            <Chip
                              label={`${area.entityCount}`}
                              size="small"
                              sx={{ fontSize: "0.7rem", height: 20 }}
                            />
                          </Box>
                          <Box
                            display="flex"
                            gap={0.5}
                            flexWrap="wrap"
                            mt={0.5}
                            ml={4}
                          >
                            {topDomains.map(([domain, count]) => (
                              <Chip
                                key={domain}
                                label={`${domainIcons[domain] ?? ""} ${domain} (${count})`}
                                size="small"
                                variant="outlined"
                                sx={{ fontSize: "0.6rem", height: 18 }}
                              />
                            ))}
                          </Box>
                        </CardContent>
                      </CardActionArea>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          </Box>

          {/* Create Button */}
          <Box display="flex" gap={2} alignItems="center">
            <Button
              onClick={() => navigate(navigation.bridges)}
              startIcon={<ArrowBackIcon />}
              disabled={creating}
            >
              {t("common.back")}
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button
              variant="contained"
              onClick={handleCreate}
              startIcon={
                creating ? <CircularProgress size={16} /> : <RocketLaunchIcon />
              }
              disabled={selectedAreas.size === 0 || creating}
            >
              {creating
                ? t("areaSetup.creating")
                : t("areaSetup.createBridges", { count: selectedAreas.size })}
            </Button>
          </Box>

          {/* Progress */}
          {creating && (
            <LinearProgress variant="determinate" value={progress} />
          )}

          {/* Results */}
          {results.length > 0 && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                {t("areaSetup.results")}
              </Typography>
              {results.map((r) => (
                <Alert
                  key={r.area}
                  severity={r.success ? "success" : "error"}
                  sx={{ mb: 0.5 }}
                >
                  {r.area}: {r.success ? t("areaSetup.created") : r.error}
                </Alert>
              ))}
              <Button
                variant="outlined"
                onClick={() => navigate(navigation.bridges)}
                sx={{ mt: 1 }}
              >
                {t("areaSetup.goToBridges")}
              </Button>
            </Box>
          )}
        </>
      )}
    </Stack>
  );
};
