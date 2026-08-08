import AddIcon from "@mui/icons-material/Add";
import BackupIcon from "@mui/icons-material/Backup";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import RestoreIcon from "@mui/icons-material/Restore";
import SecurityIcon from "@mui/icons-material/Security";
import SettingsIcon from "@mui/icons-material/Settings";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type BackupMetadata,
  type BackupSettings,
  createBackupSnapshot,
  deleteBackupSnapshot,
  downloadBackupSnapshot,
  fetchBackupSettings,
  fetchBackupSnapshots,
  restoreBackupSnapshot,
  updateBackupSettings,
} from "../../api/backup.js";

interface BackupPreview {
  version: number;
  createdAt: string;
  includesIdentity: boolean;
  bridges: Array<{
    id: string;
    name: string;
    port: number;
    exists: boolean;
    hasMappings: boolean;
    mappingCount: number;
  }>;
}

interface RestoreResult {
  bridgesRestored: number;
  bridgesSkipped: number;
  mappingsRestored: number;
  identitiesRestored: number;
  errors: Array<{ bridgeId: string; error: string }>;
  restartRequired?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BackupRestore() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [selectedBridges, setSelectedBridges] = useState<Set<string>>(
    new Set(),
  );
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [includeMappings, setIncludeMappings] = useState(true);
  const [restoreIdentity, setRestoreIdentity] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [snapshots, setSnapshots] = useState<BackupMetadata[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [snapshotRestoreTarget, setSnapshotRestoreTarget] = useState<
    string | null
  >(null);
  const [snapshotDeleteTarget, setSnapshotDeleteTarget] = useState<
    string | null
  >(null);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      setSnapshotsLoading(true);
      const [snaps, backupSettings] = await Promise.all([
        fetchBackupSnapshots(),
        fetchBackupSettings(),
      ]);
      setSnapshots(snaps);
      setSettings(backupSettings);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load backups");
    } finally {
      setSnapshotsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSnapshots();
  }, [loadSnapshots]);

  const handleCreateSnapshot = async () => {
    setCreatingSnapshot(true);
    setError(null);
    try {
      await createBackupSnapshot();
      setSuccess(t("backup.snapshotCreated"));
      await loadSnapshots();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create backup");
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleDownloadSnapshot = async (filename: string) => {
    try {
      await downloadBackupSnapshot(filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to download backup");
    }
  };

  const handleRestoreSnapshot = async (filename: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await restoreBackupSnapshot(filename);
      if (result.errors.length > 0) {
        setError(
          `Restored ${result.bridgesRestored} bridges with ${result.errors.length} errors`,
        );
      } else {
        setSuccess(
          t("backup.snapshotRestored", {
            bridges: result.bridgesRestored,
            mappings: result.mappingsRestored,
            identities: result.identitiesRestored,
          }),
        );
      }
      setSnapshotRestoreTarget(null);
      if (result.restartRequired) {
        setRestartDialogOpen(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restore backup");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteSnapshot = async (filename: string) => {
    try {
      await deleteBackupSnapshot(filename);
      setSnapshotDeleteTarget(null);
      await loadSnapshots();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete backup");
    }
  };

  const handleSettingsChange = async (changes: Partial<BackupSettings>) => {
    try {
      const updated = await updateBackupSettings(changes);
      setSettings(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update settings");
    }
  };

  const handleDownloadBackup = async (withIdentity: boolean = false) => {
    setLoading(true);
    setError(null);
    try {
      const downloadUrl = withIdentity
        ? "api/backup/download?includeIdentity=true"
        : "api/backup/download";
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error("Failed to create backup");
      }
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="(.+)"/)?.[1] || "hamh-backup.zip";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
      setSuccess(t("backup.downloadSuccess"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadedFile(file);
    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("api/backup/restore/preview", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        let msg = "Failed to parse backup";
        try {
          const data = JSON.parse(text);
          if (data.error) msg = data.error;
        } catch {
          if (text)
            msg = `${msg} (HTTP ${response.status}: ${text.slice(0, 120)})`;
        }
        throw new Error(msg);
      }

      const previewData = (await response.json()) as BackupPreview;
      setPreview(previewData);
      setSelectedBridges(new Set(previewData.bridges.map((b) => b.id)));
      setDialogOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleRestore = async () => {
    if (!uploadedFile) return;

    setLoading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", uploadedFile);
      formData.append(
        "options",
        JSON.stringify({
          bridgeIds: Array.from(selectedBridges),
          overwriteExisting,
          includeMappings,
          restoreIdentity: restoreIdentity && preview?.includesIdentity,
        }),
      );

      const response = await fetch("api/backup/restore", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const text = await response.text();
        let msg = "Failed to restore backup";
        try {
          const data = JSON.parse(text);
          if (data.error) msg = data.error;
        } catch {
          if (text)
            msg = `${msg} (HTTP ${response.status}: ${text.slice(0, 120)})`;
        }
        throw new Error(msg);
      }

      const result = (await response.json()) as RestoreResult;

      if (result.errors.length > 0) {
        setError(
          `Restored ${result.bridgesRestored} bridges with ${result.errors.length} errors`,
        );
      } else {
        const parts = [`Restored ${result.bridgesRestored} bridges`];
        if (result.mappingsRestored > 0) {
          parts.push(`${result.mappingsRestored} entity mappings`);
        }
        if (result.identitiesRestored > 0) {
          parts.push(`${result.identitiesRestored} identities`);
        }
        setSuccess(`${parts.join(", ")}!`);
      }

      setDialogOpen(false);
      setPreview(null);
      setUploadedFile(null);

      if (result.restartRequired) {
        setRestartDialogOpen(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const toggleBridge = (id: string) => {
    const newSet = new Set(selectedBridges);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedBridges(newSet);
  };

  const handleRestart = async () => {
    setLoading(true);
    try {
      await fetch("api/backup/restart", { method: "POST" });
      // The app will restart, so we just wait
      setSuccess("Application is restarting...");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restart");
    } finally {
      setLoading(false);
      setRestartDialogOpen(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          <BackupIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          {t("backup.title")}
        </Typography>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("backup.description")}
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert
            severity="success"
            sx={{ mb: 2 }}
            onClose={() => setSuccess(null)}
          >
            {success}
          </Alert>
        )}

        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 4 }}>
            <Paper
              sx={{
                p: 2,
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <BackupIcon color="primary" />
                <Typography variant="subtitle1" fontWeight="bold">
                  {t("backup.configBackup")}
                </Typography>
              </Box>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("backup.configBackupDesc")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("backup.configBackupNote")}
                </Typography>
              </Box>
              <Button
                variant="contained"
                startIcon={
                  loading ? (
                    <CircularProgress size={20} color="inherit" />
                  ) : (
                    <BackupIcon />
                  )
                }
                onClick={() => handleDownloadBackup(false)}
                disabled={loading}
                fullWidth
                sx={{ mt: 2 }}
              >
                {t("backup.configBackup")}
              </Button>
            </Paper>
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <Paper
              sx={{
                p: 2,
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <SecurityIcon color="warning" />
                <Typography variant="subtitle1" fontWeight="bold">
                  {t("backup.fullBackup")}
                </Typography>
              </Box>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("backup.fullBackupDesc")}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("backup.fullBackupWarning")}
                </Typography>
              </Box>
              <Button
                variant="contained"
                color="warning"
                startIcon={
                  loading ? (
                    <CircularProgress size={20} color="inherit" />
                  ) : (
                    <BackupIcon />
                  )
                }
                onClick={() => handleDownloadBackup(true)}
                disabled={loading}
                fullWidth
                sx={{ mt: 2 }}
              >
                {t("backup.fullBackup")}
              </Button>
            </Paper>
          </Grid>

          <Grid size={{ xs: 12, md: 4 }}>
            <Paper
              sx={{
                p: 2,
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box display="flex" alignItems="center" gap={1} mb={1}>
                <RestoreIcon color="info" />
                <Typography variant="subtitle1" fontWeight="bold">
                  {t("backup.restoreFromBackup")}
                </Typography>
              </Box>
              <Box sx={{ flexGrow: 1 }}>
                <Typography variant="body2" color="text.secondary">
                  {t("backup.restoreDesc")}
                </Typography>
              </Box>
              <Button
                variant="outlined"
                color="info"
                startIcon={<RestoreIcon />}
                component="label"
                disabled={loading}
                fullWidth
                sx={{ mt: 2 }}
              >
                {t("backup.restoreFromBackup")}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip"
                  hidden
                  onChange={handleFileSelect}
                />
              </Button>
            </Paper>
          </Grid>
        </Grid>

        <Divider sx={{ my: 3 }} />

        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          mb={2}
        >
          <Box display="flex" alignItems="center" gap={1}>
            <BackupIcon color="primary" />
            <Typography variant="subtitle1" fontWeight="bold">
              {t("backup.storedBackups")}
            </Typography>
            {snapshots.length > 0 && (
              <Chip
                label={snapshots.length}
                size="small"
                color="primary"
                variant="outlined"
              />
            )}
          </Box>
          <Button
            variant="outlined"
            size="small"
            startIcon={
              creatingSnapshot ? (
                <CircularProgress size={16} color="inherit" />
              ) : (
                <AddIcon />
              )
            }
            onClick={handleCreateSnapshot}
            disabled={creatingSnapshot}
          >
            {t("backup.createSnapshot")}
          </Button>
        </Box>

        {snapshotsLoading ? (
          <Box display="flex" justifyContent="center" p={2}>
            <CircularProgress size={24} />
          </Box>
        ) : snapshots.length === 0 ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ textAlign: "center", py: 2 }}
          >
            {t("backup.noSnapshots")}
          </Typography>
        ) : (
          <List dense>
            {snapshots.map((snap) => (
              <ListItem
                key={snap.filename}
                secondaryAction={
                  <Box display="flex" gap={0.5}>
                    <Tooltip title={t("backup.downloadSnapshot")}>
                      <IconButton
                        size="small"
                        onClick={() => handleDownloadSnapshot(snap.filename)}
                      >
                        <DownloadIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t("backup.restoreSnapshot")}>
                      <IconButton
                        size="small"
                        color="warning"
                        onClick={() => setSnapshotRestoreTarget(snap.filename)}
                      >
                        <RestoreIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t("common.delete")}>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => setSnapshotDeleteTarget(snap.filename)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                }
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <BackupIcon
                    fontSize="small"
                    color={snap.auto ? "action" : "primary"}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={
                    <Box display="flex" alignItems="center" gap={1}>
                      <Typography variant="body2">v{snap.version}</Typography>
                      <Chip
                        label={
                          snap.auto ? t("backup.auto") : t("backup.manual")
                        }
                        size="small"
                        variant="outlined"
                        color={snap.auto ? "default" : "primary"}
                      />
                      <Typography variant="body2" color="text.secondary">
                        {formatSize(snap.sizeBytes)}
                      </Typography>
                    </Box>
                  }
                  secondary={new Date(snap.createdAt).toLocaleString()}
                />
              </ListItem>
            ))}
          </List>
        )}

        <Divider sx={{ my: 3 }} />

        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <SettingsIcon color="action" />
          <Typography variant="subtitle1" fontWeight="bold">
            {t("backup.settings")}
          </Typography>
        </Box>

        {settings && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              maxWidth: 400,
            }}
          >
            <FormControlLabel
              control={
                <Switch
                  checked={settings.autoBackup}
                  onChange={(e) =>
                    handleSettingsChange({ autoBackup: e.target.checked })
                  }
                />
              }
              label={t("backup.autoBackupLabel")}
            />
            <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
              {t("backup.autoBackupDesc")}
            </Typography>
            <TextField
              label={t("backup.retentionCount")}
              type="number"
              size="small"
              value={settings.backupRetentionCount}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (val >= 1 && val <= 100) {
                  handleSettingsChange({ backupRetentionCount: val });
                }
              }}
              inputProps={{ min: 1, max: 100 }}
              helperText={t("backup.retentionCountDesc")}
              sx={{ maxWidth: 200 }}
            />
          </Box>
        )}
      </CardContent>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{t("backup.restoreTitle")}</DialogTitle>
        <DialogContent>
          {preview && (
            <>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Backup created: {new Date(preview.createdAt).toLocaleString()}
              </Typography>
              {preview.includesIdentity && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  This backup includes Matter identity data (keypairs, fabric
                  credentials). Restoring identities allows bridges to reconnect
                  without re-commissioning.
                </Alert>
              )}

              <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
                {t("backup.selectBridges")}:
              </Typography>

              <List dense>
                {preview.bridges.map((bridge) => (
                  <ListItem
                    key={bridge.id}
                    onClick={() => toggleBridge(bridge.id)}
                    sx={{ cursor: "pointer" }}
                  >
                    <ListItemIcon>
                      <Checkbox
                        edge="start"
                        checked={selectedBridges.has(bridge.id)}
                        tabIndex={-1}
                        disableRipple
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={bridge.name}
                      secondary={
                        <>
                          Port: {bridge.port}
                          {bridge.hasMappings &&
                            ` • ${bridge.mappingCount} entity mappings`}
                          {bridge.exists && (
                            <Typography
                              component="span"
                              color="warning.main"
                              sx={{ ml: 1 }}
                            >
                              (exists)
                            </Typography>
                          )}
                        </>
                      }
                    />
                  </ListItem>
                ))}
              </List>

              <Box sx={{ mt: 2 }}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={overwriteExisting}
                      onChange={(e) => setOverwriteExisting(e.target.checked)}
                    />
                  }
                  label={t("backup.overwriteExisting")}
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={includeMappings}
                      onChange={(e) => setIncludeMappings(e.target.checked)}
                    />
                  }
                  label={t("backup.includeMappings")}
                />
                {preview?.includesIdentity && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={restoreIdentity}
                        onChange={(e) => setRestoreIdentity(e.target.checked)}
                      />
                    }
                    label={t("backup.restoreIdentities")}
                  />
                )}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={handleRestore}
            disabled={loading || selectedBridges.size === 0}
            startIcon={
              loading ? <CircularProgress size={20} color="inherit" /> : null
            }
          >
            {t("backup.restore")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
      >
        <DialogTitle>
          <RestartAltIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          {t("backup.restartRequired")}
        </DialogTitle>
        <DialogContent>
          <Typography>{t("backup.restartMessage")}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t("backup.restartNote")}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestartDialogOpen(false)}>
            {t("common.later")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={handleRestart}
            disabled={loading}
            startIcon={
              loading ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                <RestartAltIcon />
              )
            }
          >
            {t("backup.restartNow")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={snapshotRestoreTarget !== null}
        onClose={() => setSnapshotRestoreTarget(null)}
      >
        <DialogTitle>
          <RestoreIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          {t("backup.confirmRestore")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {t("backup.confirmRestoreMessage", {
              filename: snapshotRestoreTarget,
            })}
          </Typography>
          <Alert severity="warning" sx={{ mt: 2 }}>
            {t("backup.restoreWarning")}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSnapshotRestoreTarget(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() =>
              snapshotRestoreTarget &&
              handleRestoreSnapshot(snapshotRestoreTarget)
            }
            disabled={loading}
            startIcon={
              loading ? <CircularProgress size={20} color="inherit" /> : null
            }
          >
            {t("backup.restore")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={snapshotDeleteTarget !== null}
        onClose={() => setSnapshotDeleteTarget(null)}
      >
        <DialogTitle>
          <DeleteIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          {t("backup.confirmDelete")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {t("backup.confirmDeleteMessage", {
              filename: snapshotDeleteTarget,
            })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSnapshotDeleteTarget(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() =>
              snapshotDeleteTarget && handleDeleteSnapshot(snapshotDeleteTarget)
            }
          >
            {t("common.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
