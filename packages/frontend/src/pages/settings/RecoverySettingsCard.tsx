import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchRecoverySettings,
  updateRecoverySettings,
} from "../../api/settings.ts";

const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 3600;

export const RecoverySettingsCard = () => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [intervalSec, setIntervalSec] = useState(60);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRecoverySettings()
      .then((s) => {
        setEnabled(s.autoRecoveryEnabled);
        setIntervalSec(Math.round(s.recoveryIntervalMs / 1000));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const s = await updateRecoverySettings({
        autoRecoveryEnabled: enabled,
        recoveryIntervalMs: intervalSec * 1000,
      });
      setEnabled(s.autoRecoveryEnabled);
      setIntervalSec(Math.round(s.recoveryIntervalMs / 1000));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 2 }}>
          {t("settings.recovery.title", "Auto recovery")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t(
            "settings.recovery.hint",
            "Periodically restarts bridges that failed to start. Only failed bridges are touched.",
          )}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress />
          </Box>
        ) : (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
              }
              label={t("settings.recovery.enabled", "Enabled")}
            />
            <TextField
              type="number"
              size="small"
              label={t("settings.recovery.interval", "Interval (seconds)")}
              value={intervalSec}
              disabled={!enabled}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              slotProps={{
                htmlInput: { min: MIN_INTERVAL_SEC, max: MAX_INTERVAL_SEC },
              }}
              sx={{ maxWidth: 220 }}
            />
            <Box>
              <Button
                variant="contained"
                onClick={save}
                disabled={
                  saving ||
                  Number.isNaN(intervalSec) ||
                  intervalSec < MIN_INTERVAL_SEC ||
                  intervalSec > MAX_INTERVAL_SEC
                }
              >
                {t("common.save", "Save")}
              </Button>
            </Box>
          </Box>
        )}
      </CardContent>
    </Card>
  );
};
