import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ExtensionIcon from "@mui/icons-material/Extension";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PowerIcon from "@mui/icons-material/Power";
import PowerOffIcon from "@mui/icons-material/PowerOff";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";

interface PluginDevice {
  id: string;
  name: string;
  deviceType: string;
}

interface CircuitBreakerInfo {
  failures: number;
  disabled: boolean;
  lastError?: string;
  disabledAt?: number;
}

interface PluginInfo {
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  config: Record<string, unknown>;
  circuitBreaker?: CircuitBreakerInfo;
  devices: PluginDevice[];
}

interface BridgePlugins {
  bridgeId: string;
  bridgeName: string;
  plugins: PluginInfo[];
}

interface InstalledPlugin {
  packageName: string;
  version: string;
  config: Record<string, unknown>;
  autoLoad: boolean;
  installedAt: number;
  path: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const PluginsPage = () => {
  const [bridgePlugins, setBridgePlugins] = useState<BridgePlugins[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [installOpen, setInstallOpen] = useState(false);
  const [installTab, setInstallTab] = useState(0);
  const [packageName, setPackageName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [installing, setInstalling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [plugins, inst] = await Promise.all([
        fetchJson<BridgePlugins[]>("api/plugins"),
        fetchJson<InstalledPlugin[]>("api/plugins/installed"),
      ]);
      setBridgePlugins(plugins);
      setInstalled(inst);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleInstall = async () => {
    if (!packageName.trim()) return;
    setInstalling(true);
    try {
      await fetchJson("api/plugins/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: packageName.trim() }),
      });
      setPackageName("");
      setInstallOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setInstalling(true);
    try {
      const buf = await selectedFile.arrayBuffer();
      const res = await fetch("api/plugins/upload", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (data as { error?: string }).error ??
            `${res.status} ${res.statusText}`,
        );
      }
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setInstallOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleLocalInstall = async () => {
    if (!localPath.trim()) return;
    setInstalling(true);
    try {
      await fetchJson("api/plugins/install-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: localPath.trim() }),
      });
      setLocalPath("");
      setInstallOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstall = async (pkg: string) => {
    try {
      await fetchJson("api/plugins/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: pkg }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handlePluginAction = async (
    bridgeId: string,
    pluginName: string,
    action: "enable" | "disable" | "reset",
  ) => {
    try {
      await fetchJson(`api/plugins/${bridgeId}/${pluginName}/${action}`, {
        method: "POST",
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const totalPlugins = bridgePlugins.reduce(
    (sum, b) => sum + b.plugins.length,
    0,
  );

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3, p: 2 }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Typography
          variant="h5"
          sx={{ display: "flex", alignItems: "center", gap: 1 }}
        >
          <ExtensionIcon /> Plugins
        </Typography>
        <Stack direction="row" spacing={1}>
          <Tooltip title="Refresh">
            <IconButton onClick={refresh}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setInstallOpen(true)}
            size="small"
          >
            Install Plugin
          </Button>
        </Stack>
      </Box>

      {error && (
        <Alert severity="error" onClose={() => setError(undefined)}>
          {error}
        </Alert>
      )}

      {totalPlugins === 0 && installed.length === 0 && (
        <Alert severity="info">
          No plugins installed. Click &quot;Install Plugin&quot; to add an npm
          plugin package, or plugins will appear here when registered by the
          bridge.
        </Alert>
      )}

      {installed.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Installed Packages
            </Typography>
            <List dense>
              {installed.map((pkg) => (
                <ListItem
                  key={pkg.packageName}
                  secondaryAction={
                    <Tooltip title="Uninstall">
                      <IconButton
                        edge="end"
                        onClick={() => handleUninstall(pkg.packageName)}
                        color="error"
                        size="small"
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  }
                >
                  <ListItemIcon>
                    <ExtensionIcon />
                  </ListItemIcon>
                  <ListItemText
                    primary={pkg.packageName}
                    secondary={`v${pkg.version} — installed ${new Date(pkg.installedAt).toLocaleDateString()}`}
                  />
                </ListItem>
              ))}
            </List>
          </CardContent>
        </Card>
      )}

      {bridgePlugins.map((bridge) => (
        <Card key={bridge.bridgeId} variant="outlined">
          <CardContent>
            <Typography variant="h6" gutterBottom>
              {bridge.bridgeName}
            </Typography>
            {bridge.plugins.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No active plugins on this bridge.
              </Typography>
            ) : (
              <List dense>
                {bridge.plugins.map((plugin) => (
                  <Box key={plugin.name}>
                    <ListItem
                      secondaryAction={
                        <Stack direction="row" spacing={0.5}>
                          {plugin.circuitBreaker?.disabled && (
                            <Tooltip title="Reset circuit breaker">
                              <IconButton
                                size="small"
                                onClick={() =>
                                  handlePluginAction(
                                    bridge.bridgeId,
                                    plugin.name,
                                    "reset",
                                  )
                                }
                              >
                                <RestartAltIcon />
                              </IconButton>
                            </Tooltip>
                          )}
                          <Tooltip
                            title={plugin.enabled ? "Disable" : "Enable"}
                          >
                            <IconButton
                              size="small"
                              onClick={() =>
                                handlePluginAction(
                                  bridge.bridgeId,
                                  plugin.name,
                                  plugin.enabled ? "disable" : "enable",
                                )
                              }
                            >
                              {plugin.enabled ? (
                                <PowerOffIcon />
                              ) : (
                                <PowerIcon />
                              )}
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      }
                    >
                      <ListItemIcon>
                        <ExtensionIcon
                          color={plugin.enabled ? "primary" : "disabled"}
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 1,
                            }}
                          >
                            {plugin.name}
                            <Chip
                              label={`v${plugin.version}`}
                              size="small"
                              variant="outlined"
                            />
                            {plugin.source === "builtin" && (
                              <Chip label="built-in" size="small" />
                            )}
                            {!plugin.enabled && (
                              <Chip
                                label="disabled"
                                size="small"
                                color="warning"
                              />
                            )}
                            {plugin.circuitBreaker?.disabled && (
                              <Chip
                                label="circuit breaker open"
                                size="small"
                                color="error"
                              />
                            )}
                          </Box>
                        }
                        secondary={
                          plugin.devices.length > 0
                            ? `${plugin.devices.length} device(s)`
                            : "No devices registered"
                        }
                      />
                    </ListItem>
                    {plugin.circuitBreaker?.disabled &&
                      plugin.circuitBreaker.lastError && (
                        <Alert severity="error" sx={{ mx: 2, mb: 1 }}>
                          {plugin.circuitBreaker.lastError}
                        </Alert>
                      )}
                    {plugin.devices.length > 0 && (
                      <List dense sx={{ pl: 6 }}>
                        {plugin.devices.map((device) => (
                          <ListItem key={device.id}>
                            <ListItemText
                              primary={device.name}
                              secondary={`${device.deviceType} — ${device.id}`}
                            />
                          </ListItem>
                        ))}
                      </List>
                    )}
                    <Divider />
                  </Box>
                ))}
              </List>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Install Plugin</DialogTitle>
        <DialogContent>
          <Tabs
            value={installTab}
            onChange={(_e, v: number) => setInstallTab(v)}
            sx={{ mb: 2 }}
          >
            <Tab label="npm" />
            <Tab label="Upload .tgz" />
            <Tab label="Local Path" />
          </Tabs>

          {installTab === 0 && (
            <>
              <TextField
                autoFocus
                margin="dense"
                label="npm package name"
                placeholder="e.g. hamh-plugin-example"
                fullWidth
                value={packageName}
                onChange={(e) => setPackageName(e.target.value)}
                disabled={installing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleInstall();
                }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                The plugin will be installed via npm. After installation,
                restart the bridge to load the plugin.
              </Typography>
            </>
          )}

          {installTab === 1 && (
            <>
              <Button
                variant="outlined"
                component="label"
                startIcon={<UploadFileIcon />}
                fullWidth
                sx={{ mt: 1 }}
                disabled={installing}
              >
                {selectedFile ? selectedFile.name : "Choose .tgz file"}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".tgz,application/gzip"
                  hidden
                  onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                />
              </Button>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Upload a packaged plugin (.tgz). Restart the bridge after
                installation.
              </Typography>
            </>
          )}

          {installTab === 2 && (
            <>
              <Box sx={{ display: "flex", alignItems: "center" }}>
                <FolderOpenIcon sx={{ mr: 1 }} />
                <TextField
                  autoFocus
                  margin="dense"
                  label="Absolute path to plugin folder"
                  placeholder="/path/to/your/plugin"
                  fullWidth
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  disabled={installing}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleLocalInstall();
                  }}
                />
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Link a local plugin directory (creates a symlink). Useful for
                development. Restart the bridge after linking.
              </Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInstallOpen(false)} disabled={installing}>
            Cancel
          </Button>
          {installTab === 0 && (
            <Button
              onClick={handleInstall}
              variant="contained"
              disabled={installing || !packageName.trim()}
            >
              {installing ? <CircularProgress size={20} /> : "Install"}
            </Button>
          )}
          {installTab === 1 && (
            <Button
              onClick={handleUpload}
              variant="contained"
              disabled={installing || !selectedFile}
            >
              {installing ? <CircularProgress size={20} /> : "Upload"}
            </Button>
          )}
          {installTab === 2 && (
            <Button
              onClick={handleLocalInstall}
              variant="contained"
              disabled={installing || !localPath.trim()}
            >
              {installing ? <CircularProgress size={20} /> : "Link"}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
};
