import BackupIcon from "@mui/icons-material/Backup";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import RestoreIcon from "@mui/icons-material/Restore";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";

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

export function BackupRestore() {
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
      setSuccess("Backup downloaded successfully!");
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
        const data = await response.json();
        throw new Error(data.error || "Failed to parse backup");
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
        const data = await response.json();
        throw new Error(data.error || "Failed to restore backup");
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
        setSuccess(parts.join(", ") + "!");
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
          Backup & Restore
        </Typography>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Create a full backup of your bridges and entity mappings, or restore
          from a previous backup.
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

        <Box display="flex" gap={2} flexWrap="wrap">
          <Button
            variant="contained"
            startIcon={
              loading ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                <CloudDownloadIcon />
              )
            }
            onClick={() => handleDownloadBackup(false)}
            disabled={loading}
          >
            Download Backup
          </Button>

          <Button
            variant="contained"
            color="secondary"
            startIcon={
              loading ? (
                <CircularProgress size={20} color="inherit" />
              ) : (
                <BackupIcon />
              )
            }
            onClick={() => handleDownloadBackup(true)}
            disabled={loading}
          >
            Full Backup (with Identity)
          </Button>

          <Button
            variant="outlined"
            startIcon={<RestoreIcon />}
            component="label"
            disabled={loading}
          >
            Restore from Backup
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              hidden
              onChange={handleFileSelect}
            />
          </Button>
        </Box>
      </CardContent>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Restore Backup</DialogTitle>
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
                Select bridges to restore:
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
                  label="Overwrite existing bridges"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={includeMappings}
                      onChange={(e) => setIncludeMappings(e.target.checked)}
                    />
                  }
                  label="Include entity mappings"
                />
                {preview?.includesIdentity && (
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={restoreIdentity}
                        onChange={(e) => setRestoreIdentity(e.target.checked)}
                      />
                    }
                    label="Restore Matter identities (no re-commissioning needed)"
                  />
                )}
              </Box>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleRestore}
            disabled={loading || selectedBridges.size === 0}
            startIcon={
              loading ? <CircularProgress size={20} color="inherit" /> : null
            }
          >
            Restore
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
      >
        <DialogTitle>
          <RestartAltIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          Restart Required
        </DialogTitle>
        <DialogContent>
          <Typography>
            Bridges have been restored from backup. A restart is required for
            the changes to take effect.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            The application will restart and you may need to refresh this page.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRestartDialogOpen(false)}>Later</Button>
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
            Restart Now
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
