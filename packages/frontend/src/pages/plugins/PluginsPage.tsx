import {
  type BridgeDataWithMetadata,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ExtensionIcon from "@mui/icons-material/Extension";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import PowerIcon from "@mui/icons-material/Power";
import PowerOffIcon from "@mui/icons-material/PowerOff";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SettingsIcon from "@mui/icons-material/Settings";
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
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBridges } from "../../hooks/data/bridges.ts";

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

// Mirrors PluginConfigSchema from the backend plugin types.
interface ConfigSchemaProperty {
  type: "string" | "number" | "boolean" | "select";
  title: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
}

interface ConfigSchema {
  title: string;
  description?: string;
  properties: Record<string, ConfigSchemaProperty>;
}

interface ConfigDialogTarget {
  bridgeId: string;
  pluginName: string;
}

function invalidNumber(text: string): boolean {
  return text.trim() !== "" && Number.isNaN(Number(text));
}

// The schema has no secret flag, so mask by field name (haToken etc).
function isSecretField(key: string): boolean {
  return /token|password|secret/i.test(key);
}

/**
 * Which empty state the page is actually in. GET /api/plugins skips server mode
 * bridges because they host no plugins (#430), so an empty response used to
 * read as "No plugins installed" and sent reporters typing built-in plugin
 * names into the npm box (#432).
 */
export type PluginsEmptyState =
  | "no-bridges"
  | "all-server-mode"
  | "bridge-not-running"
  | "none-installed";

export function pluginsEmptyState(input: {
  bridges: BridgeDataWithMetadata[] | undefined;
  bridgePlugins: BridgePlugins[];
  installed: InstalledPlugin[];
}): PluginsEmptyState | undefined {
  const { bridges, bridgePlugins, installed } = input;
  const totalPlugins = bridgePlugins.reduce(
    (sum, b) => sum + b.plugins.length,
    0,
  );
  if (totalPlugins > 0 || installed.length > 0) {
    return undefined;
  }
  if (bridges == null) {
    // Loading or load failure: keep the generic hint, never a blank page.
    return "none-installed";
  }
  if (bridges.length === 0) {
    return "no-bridges";
  }
  const pluginCapable = bridges.filter((b) => !b.featureFlags?.serverMode);
  if (pluginCapable.length === 0) {
    return "all-server-mode";
  }
  if (!pluginCapable.some((b) => b.status === BridgeStatus.Running)) {
    return "bridge-not-running";
  }
  return "none-installed";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    // The backend explains rejections in the body, e.g. a built-in plugin name
    // typed into the npm field (#432). "400 Bad Request" alone helps nobody.
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export const PluginsPage = () => {
  const { content: bridges } = useBridges();
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
  // Install failures stay inside the dialog: it stays open on error, so the
  // page-level alert would sit behind it.
  const [installError, setInstallError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [configTarget, setConfigTarget] = useState<ConfigDialogTarget>();
  // undefined while the schema loads, null when the plugin has no settings
  const [configSchema, setConfigSchema] = useState<ConfigSchema | null>();
  // Config the plugin already has, so keys outside the schema survive a save.
  const [configExisting, setConfigExisting] = useState<Record<string, unknown>>(
    {},
  );
  // Bumped on every dialog open; a schema response from an earlier open
  // must not touch the state of a newer one.
  const configEpoch = useRef(0);
  const [configValues, setConfigValues] = useState<
    Record<string, string | boolean>
  >({});
  const [configError, setConfigError] = useState<string>();
  const [savingConfig, setSavingConfig] = useState(false);

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
    setInstallError(undefined);
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
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;
    setInstalling(true);
    setInstallError(undefined);
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
      setInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const handleLocalInstall = async () => {
    if (!localPath.trim()) return;
    setInstalling(true);
    setInstallError(undefined);
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
      setInstallError(e instanceof Error ? e.message : String(e));
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
      await fetchJson(
        `api/plugins/${encodeURIComponent(bridgeId)}/${encodeURIComponent(pluginName)}/${action}`,
        { method: "POST" },
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const closeConfigDialog = () => {
    // A response still in flight for this dialog must land in the void.
    configEpoch.current++;
    setConfigTarget(undefined);
  };

  const openPluginConfig = async (bridgeId: string, plugin: PluginInfo) => {
    const epoch = ++configEpoch.current;
    setConfigTarget({ bridgeId, pluginName: plugin.name });
    setConfigSchema(undefined);
    setConfigError(undefined);
    setConfigValues({});
    setConfigExisting(plugin.config ?? {});
    try {
      const res = await fetchJson<{ schema: ConfigSchema | null }>(
        `api/plugins/${encodeURIComponent(bridgeId)}/${encodeURIComponent(plugin.name)}/config-schema`,
      );
      if (epoch !== configEpoch.current) return;
      const schema = res.schema ?? null;
      if (schema) {
        const values: Record<string, string | boolean> = {};
        for (const [key, prop] of Object.entries(schema.properties)) {
          const current = plugin.config[key] ?? prop.default;
          values[key] =
            prop.type === "boolean"
              ? Boolean(current ?? false)
              : current == null
                ? ""
                : String(current);
        }
        setConfigValues(values);
      }
      setConfigSchema(schema);
    } catch (e) {
      // The schema route answers 200 with schema null when there is nothing
      // to configure, so landing here is a real failure, not "no settings".
      if (epoch !== configEpoch.current) return;
      setConfigSchema(null);
      setConfigError(e instanceof Error ? e.message : String(e));
    }
  };

  // Required fields must be filled and number fields numeric before save.
  const configBlocked =
    configSchema == null ||
    Object.entries(configSchema.properties).some(([key, prop]) => {
      if (prop.type === "boolean") return false;
      const value = configValues[key];
      const text = typeof value === "string" ? value.trim() : "";
      if (prop.required && text === "") return true;
      return prop.type === "number" && invalidNumber(text);
    });

  const handleSaveConfig = async () => {
    if (!configTarget || !configSchema) return;
    // Start from what the plugin already has: the backend replaces the whole
    // config, and a plugin may keep keys the schema does not list.
    const config: Record<string, unknown> = { ...configExisting };
    for (const [key, prop] of Object.entries(configSchema.properties)) {
      const value = configValues[key];
      if (prop.type === "boolean") {
        config[key] = value === true;
        continue;
      }
      const text = typeof value === "string" ? value.trim() : "";
      if (text === "") {
        delete config[key]; // a blanked field clears the stored value
        continue;
      }
      config[key] = prop.type === "number" ? Number(text) : text;
    }
    const epoch = configEpoch.current;
    setSavingConfig(true);
    setConfigError(undefined);
    try {
      await fetchJson(
        `api/plugins/${encodeURIComponent(configTarget.bridgeId)}/${encodeURIComponent(configTarget.pluginName)}/config`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config }),
        },
      );
      if (epoch === configEpoch.current) setConfigTarget(undefined);
      await refresh();
    } catch (e) {
      // A save whose dialog is gone must not close or scribble on a newer one.
      if (epoch === configEpoch.current) {
        setConfigError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const emptyState = pluginsEmptyState({ bridges, bridgePlugins, installed });
  const serverModeBridges =
    bridges?.filter((b) => b.featureFlags?.serverMode) ?? [];

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
            onClick={() => {
              setInstallError(undefined);
              setInstallOpen(true);
            }}
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

      {emptyState === "no-bridges" && (
        <Alert severity="info">
          No bridges configured. Create a bridge first, then plugins registered
          on it appear here.
        </Alert>
      )}

      {emptyState === "all-server-mode" && (
        <Alert severity="info">
          Plugins run on standard bridges. Server mode bridges host none,
          including the built-in camera. Create a standard bridge to use
          plugins.
        </Alert>
      )}

      {emptyState === "bridge-not-running" && (
        <Alert severity="info">
          No plugins reported yet. Plugins load when the bridge starts, so start
          the bridge and refresh this page.
        </Alert>
      )}

      {emptyState === "none-installed" && (
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
                    secondary={`v${pkg.version}, installed ${new Date(pkg.installedAt).toLocaleDateString()}`}
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
                      disablePadding
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
                          <Tooltip title="Settings">
                            <IconButton
                              size="small"
                              onClick={() =>
                                openPluginConfig(bridge.bridgeId, plugin)
                              }
                            >
                              <SettingsIcon />
                            </IconButton>
                          </Tooltip>
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
                      {/* The whole row opens the settings: that is where
                          reporters clicked expecting them (#432). */}
                      <ListItemButton
                        onClick={() =>
                          openPluginConfig(bridge.bridgeId, plugin)
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
                      </ListItemButton>
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
                              secondary={`${device.deviceType}, ${device.id}`}
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

      {/* Account for every bridge, so a server mode bridge missing from
          /api/plugins does not read as a bug (#432). */}
      {serverModeBridges.map((bridge) => (
        <Card key={bridge.id} variant="outlined">
          <CardContent>
            <Typography variant="h6" gutterBottom>
              {bridge.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Server mode bridge, hosts no plugins.
            </Typography>
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
            onChange={(_e, v: number) => {
              setInstallTab(v);
              setInstallError(undefined);
            }}
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
                onChange={(e) => {
                  setPackageName(e.target.value);
                  setInstallError(undefined);
                }}
                disabled={installing}
                error={!!installError}
                helperText={installError}
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
                  onChange={(e) => {
                    setSelectedFile(e.target.files?.[0] ?? null);
                    setInstallError(undefined);
                  }}
                />
              </Button>
              {installError && (
                <FormHelperText error sx={{ mt: 1 }}>
                  {installError}
                </FormHelperText>
              )}
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                Upload a packaged plugin (.tgz). Restart the bridge after
                installation.
              </Typography>
            </>
          )}

          {installTab === 2 && (
            <>
              <TextField
                autoFocus
                margin="dense"
                label="Absolute path to plugin folder"
                placeholder="/path/to/your/plugin"
                fullWidth
                value={localPath}
                onChange={(e) => {
                  setLocalPath(e.target.value);
                  setInstallError(undefined);
                }}
                disabled={installing}
                error={!!installError}
                helperText={installError}
                InputProps={{
                  startAdornment: <FolderOpenIcon sx={{ mr: 1 }} />,
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLocalInstall();
                }}
              />
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

      <Dialog
        open={!!configTarget}
        onClose={() => {
          if (!savingConfig) closeConfigDialog();
        }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {configSchema?.title ?? configTarget?.pluginName} Settings
        </DialogTitle>
        <DialogContent>
          {configSchema === undefined && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
              <CircularProgress size={24} />
            </Box>
          )}
          {configSchema === null && !configError && (
            <Typography variant="body2" color="text.secondary">
              This plugin has no settings.
            </Typography>
          )}
          {configSchema && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              {configSchema.description && (
                <Typography variant="body2" color="text.secondary">
                  {configSchema.description}
                </Typography>
              )}
              {Object.entries(configSchema.properties).map(([key, prop]) => {
                if (prop.type === "boolean") {
                  return (
                    <Box key={key}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={configValues[key] === true}
                            onChange={(e) =>
                              setConfigValues((v) => ({
                                ...v,
                                [key]: e.target.checked,
                              }))
                            }
                          />
                        }
                        label={prop.title}
                      />
                      {prop.description && (
                        <FormHelperText>{prop.description}</FormHelperText>
                      )}
                    </Box>
                  );
                }
                const text =
                  typeof configValues[key] === "string"
                    ? (configValues[key] as string)
                    : "";
                const badNumber = prop.type === "number" && invalidNumber(text);
                return (
                  <TextField
                    key={key}
                    label={prop.title}
                    fullWidth
                    select={prop.type === "select"}
                    type={
                      prop.type === "number"
                        ? "number"
                        : isSecretField(key)
                          ? "password"
                          : "text"
                    }
                    required={prop.required}
                    value={text}
                    onChange={(e) =>
                      setConfigValues((v) => ({
                        ...v,
                        [key]: e.target.value,
                      }))
                    }
                    error={badNumber}
                    helperText={
                      badNumber ? "Must be a number" : prop.description
                    }
                    disabled={savingConfig}
                  >
                    {prop.type === "select" &&
                      (prop.options ?? []).map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                  </TextField>
                );
              })}
            </Stack>
          )}
          {configError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {configError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfigDialog} disabled={savingConfig}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveConfig}
            variant="contained"
            disabled={savingConfig || configBlocked}
          >
            {savingConfig ? <CircularProgress size={20} /> : "Save"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
