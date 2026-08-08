import DeleteIcon from "@mui/icons-material/Delete";
import SaveIcon from "@mui/icons-material/Save";
import SecurityIcon from "@mui/icons-material/Security";
import SettingsIcon from "@mui/icons-material/Settings";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteAuthSettings,
  fetchAuthSettings,
  type SettingsAuthResponse,
  updateAuthSettings,
} from "../../api/settings.ts";
import { BackupRestore } from "../../components/backup/BackupRestore.tsx";
import { ConfirmDialog } from "../../components/misc/ConfirmDialog.tsx";
import { UpdateChecker } from "../../components/system/UpdateChecker.tsx";
import { RecoverySettingsCard } from "./RecoverySettingsCard.tsx";

export const SettingsPage = () => {
  const { t } = useTranslation();
  const [authState, setAuthState] = useState<SettingsAuthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const loadAuthSettings = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchAuthSettings();
      setAuthState(response);
      if (response.username) {
        setUsername(response.username);
      }
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.authLoadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadAuthSettings();
  }, [loadAuthSettings]);

  const handleSave = async () => {
    if (!username.trim() || !password.trim()) {
      setError(t("settings.usernamePasswordRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await updateAuthSettings(username.trim(), password);
      setAuthState(response);
      setPassword("");
      setSuccess(
        "Authentication enabled. The browser will prompt you to log in on the next request.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.authSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const [confirmDisableAuth, setConfirmDisableAuth] = useState(false);

  const handleRemove = async () => {
    setConfirmDisableAuth(false);
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await deleteAuthSettings();
      setAuthState(response);
      setUsername("");
      setPassword("");
      setSuccess(t("settings.authDisabled"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("settings.authRemoveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const isEnvConfigured = authState?.source === "environment";

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" component="h1" sx={{ mb: 3 }}>
        <SettingsIcon sx={{ mr: 1, verticalAlign: "middle" }} />
        {t("settings.title")}
      </Typography>

      <BackupRestore />

      <Divider sx={{ my: 3 }} />

      <UpdateChecker />

      <Divider sx={{ my: 3 }} />

      <RecoverySettingsCard />

      <Divider sx={{ my: 3 }} />

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>
              <SecurityIcon
                sx={{ mr: 1, verticalAlign: "middle", fontSize: 20 }}
              />
              {t("settings.title")}
            </Typography>

            {isEnvConfigured && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Authentication is configured via environment variables (
                <code>HAMH_HTTP_AUTH_USERNAME</code> /{" "}
                <code>HAMH_HTTP_AUTH_PASSWORD</code>). Remove the environment
                variables to manage authentication from here.
              </Alert>
            )}

            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            {success && (
              <Alert severity="success" sx={{ mb: 2 }}>
                {success}
              </Alert>
            )}

            {authState?.enabled && !isEnvConfigured && (
              <Alert severity="info" sx={{ mb: 2 }}>
                Authentication is currently enabled for user &quot;
                {authState.username}&quot;. Enter a new password to change it,
                or remove authentication entirely.
              </Alert>
            )}

            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                maxWidth: 400,
              }}
            >
              <TextField
                label={t("settings.username")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isEnvConfigured || saving}
                fullWidth
                size="small"
              />
              <TextField
                label={t("settings.password")}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isEnvConfigured || saving}
                fullWidth
                size="small"
                placeholder={
                  authState?.enabled && !isEnvConfigured
                    ? t("settings.enterNewPassword")
                    : ""
                }
              />
              <Box sx={{ display: "flex", gap: 1 }}>
                <Button
                  variant="contained"
                  onClick={handleSave}
                  disabled={
                    isEnvConfigured ||
                    saving ||
                    !username.trim() ||
                    !password.trim()
                  }
                  startIcon={
                    saving ? <CircularProgress size={16} /> : <SaveIcon />
                  }
                >
                  {authState?.enabled && !isEnvConfigured
                    ? t("common.update")
                    : t("settings.enableAuth")}
                </Button>
                {authState?.enabled && !isEnvConfigured && (
                  <Button
                    variant="outlined"
                    color="error"
                    onClick={() => setConfirmDisableAuth(true)}
                    disabled={saving}
                    startIcon={<DeleteIcon />}
                  >
                    {t("common.disabled")}
                  </Button>
                )}
              </Box>
            </Box>

            <Alert severity="warning" sx={{ mt: 3 }}>
              If you get locked out, delete the settings from the storage
              directory or set <code>HAMH_HTTP_AUTH_USERNAME</code> /{" "}
              <code>HAMH_HTTP_AUTH_PASSWORD</code> environment variables in your
              Docker Compose file to regain access.
            </Alert>
          </CardContent>
        </Card>
      )}
      <ConfirmDialog
        open={confirmDisableAuth}
        title={t("settings.disableAuth")}
        message={t("settings.disableAuthMessage")}
        confirmLabel={t("settings.disableAuthConfirm")}
        confirmColor="error"
        onConfirm={handleRemove}
        onCancel={() => setConfirmDisableAuth(false)}
      />
    </Box>
  );
};
