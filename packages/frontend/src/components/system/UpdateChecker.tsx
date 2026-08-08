import NewReleasesIcon from "@mui/icons-material/NewReleases";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string;
  releaseNotes?: string;
  environment: string;
}

export const UpdateChecker = () => {
  const { t } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkForUpdates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("api/system/update-check");
      if (res.ok) {
        setUpdateInfo(await res.json());
      } else if (res.status === 404) {
        setError(t("updateChecker.notAvailable"));
      } else {
        setError(t("updateChecker.checkFailed"));
      }
    } catch {
      setError(t("updateChecker.unreachable"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const getUpdateInstructions = (env: string): string => {
    switch (env) {
      case "Home Assistant Add-on":
        return t("updateChecker.instructionAddon");
      case "Docker":
        return t("updateChecker.instructionDocker");
      default:
        return t("updateChecker.instructionNpm");
    }
  };

  return (
    <Card>
      <CardContent>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            mb: 2,
          }}
        >
          <Typography
            variant="h6"
            sx={{ display: "flex", alignItems: "center", gap: 1 }}
          >
            <NewReleasesIcon />
            {t("updateChecker.title")}
          </Typography>
          <Button
            size="small"
            startIcon={
              loading ? <CircularProgress size={16} /> : <RefreshIcon />
            }
            onClick={checkForUpdates}
            disabled={loading}
          >
            {t("updateChecker.checkNow")}
          </Button>
        </Box>

        {error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {updateInfo && (
          <Stack spacing={2}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Typography variant="body2">
                {t("updateChecker.currentVersion")}:
              </Typography>
              <Chip
                label={updateInfo.currentVersion}
                size="small"
                color="primary"
              />
            </Box>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Typography variant="body2">
                {t("updateChecker.latestVersion")}:
              </Typography>
              <Chip
                label={updateInfo.latestVersion}
                size="small"
                color={updateInfo.updateAvailable ? "warning" : "success"}
              />
            </Box>

            {updateInfo.updateAvailable ? (
              <Alert
                severity="info"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    endIcon={<OpenInNewIcon />}
                    href={updateInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("updateChecker.releaseNotes")}
                  </Button>
                }
              >
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {t("updateChecker.updateAvailable")}
                </Typography>
                <Typography variant="body2">
                  {getUpdateInstructions(updateInfo.environment)}
                </Typography>
              </Alert>
            ) : (
              <Alert severity="success">{t("updateChecker.upToDate")}</Alert>
            )}

            {updateInfo.releaseNotes && updateInfo.updateAvailable && (
              <Box
                sx={{
                  p: 1.5,
                  borderRadius: 1,
                  bgcolor: "action.hover",
                  maxHeight: 400,
                  overflow: "auto",
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ whiteSpace: "pre-wrap" }}
                >
                  {updateInfo.releaseNotes}
                </Typography>
              </Box>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
};
