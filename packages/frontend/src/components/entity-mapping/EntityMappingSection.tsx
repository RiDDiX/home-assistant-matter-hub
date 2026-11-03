import type {
  EntityMappingConfig,
  EntityMappingResponse,
  MappingProfile,
  MappingProfileImportPreview,
} from "@home-assistant-matter-hub/common";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import SettingsIcon from "@mui/icons-material/Settings";
import UploadIcon from "@mui/icons-material/Upload";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteEntityMapping,
  fetchEntityMappings,
  updateEntityMapping,
} from "../../api/entity-mappings.js";
import {
  applyMappingProfileImport,
  exportMappingProfile,
  previewMappingProfileImport,
} from "../../api/mapping-profiles.js";
import { useDevices } from "../../hooks/data/devices.js";
import { collectLeafEndpoints } from "../endpoints/collect-leaf-endpoints.js";
import { ConfirmDialog } from "../misc/ConfirmDialog.js";
import { useNotifications } from "../notifications/use-notifications.js";
import { EntityMappingDialog } from "./EntityMappingDialog.js";

interface EntityMappingSectionProps {
  bridgeId: string;
}

export function EntityMappingSection({ bridgeId }: EntityMappingSectionProps) {
  const { t } = useTranslation();
  const notifications = useNotifications();
  const { content: devices } = useDevices(bridgeId);
  const [mappings, setMappings] = useState<EntityMappingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEntity, setEditingEntity] = useState<{
    entityId: string;
    domain: string;
    config?: EntityMappingConfig;
  } | null>(null);
  const [importPreview, setImportPreview] =
    useState<MappingProfileImportPreview | null>(null);
  const [importProfile, setImportProfile] = useState<MappingProfile | null>(
    null,
  );
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportSelected, setExportSelected] = useState<Set<string>>(new Set());
  const [exportProfileName, setExportProfileName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // profile entries can only match entities that are on this bridge
  const bridgeEntityIds = useMemo(() => {
    if (!devices) return [];
    return collectLeafEndpoints(devices).flatMap((ep) => {
      const id = (
        ep.state as {
          homeAssistantEntity?: { entity?: { entity_id?: string } };
        }
      ).homeAssistantEntity?.entity?.entity_id;
      return id ? [id] : [];
    });
  }, [devices]);

  const loadMappings = useCallback(async () => {
    try {
      const data = await fetchEntityMappings(bridgeId);
      setMappings(data);
      setError(null);
    } catch {
      setError(t("mapping.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [bridgeId, t]);

  useEffect(() => {
    loadMappings();
  }, [loadMappings]);

  const handleAddMapping = useCallback(() => {
    setEditingEntity({ entityId: "", domain: "" });
    setDialogOpen(true);
  }, []);

  const handleEditMapping = useCallback(
    (entityId: string, config: EntityMappingConfig) => {
      const domain = entityId.split(".")[0] || "";
      setEditingEntity({ entityId, domain, config });
      setDialogOpen(true);
    },
    [],
  );

  const handleDeleteMapping = useCallback(
    async (entityId: string) => {
      setPendingDelete(null);
      try {
        await deleteEntityMapping(bridgeId, entityId);
        setSuccessMsg(t("mapping.deleted", { entityId }));
        await loadMappings();
      } catch {
        setError(t("mapping.deleteFailed"));
      }
    },
    [bridgeId, loadMappings, t],
  );

  const handleSave = useCallback(
    async (config: Partial<EntityMappingConfig>) => {
      if (!config.entityId) return;
      try {
        await updateEntityMapping(bridgeId, config.entityId, config);
        setDialogOpen(false);
        setEditingEntity(null);
        await loadMappings();
      } catch (e) {
        // a toast, the inline alert sits behind the open dialog
        notifications.show({
          message: t("mapping.saveFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
          severity: "error",
        });
      }
    },
    [bridgeId, loadMappings, notifications, t],
  );

  const handleClose = useCallback(() => {
    setDialogOpen(false);
    setEditingEntity(null);
  }, []);

  // mappings.mappings is an array of EntityMappingConfig, not an object
  const mappingsList = mappings?.mappings ?? [];

  const handleExportClick = useCallback(() => {
    const allIds = new Set(mappingsList.map((m) => m.entityId));
    setExportSelected(allIds);
    setExportProfileName(t("mapping.defaultProfileName"));
    setExportDialogOpen(true);
  }, [mappingsList, t]);

  const handleExportConfirm = useCallback(async () => {
    try {
      const entityIds = [...exportSelected];
      const profile = await exportMappingProfile(
        bridgeId,
        exportProfileName,
        entityIds,
      );
      const blob = new Blob([JSON.stringify(profile, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mapping-profile-${bridgeId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportDialogOpen(false);
    } catch {
      setError(t("mapping.exportFailed"));
    }
  }, [bridgeId, exportSelected, exportProfileName, t]);

  const handleExportCancel = useCallback(() => {
    setExportDialogOpen(false);
  }, []);

  const toggleExportEntity = useCallback((entityId: string) => {
    setExportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entityId)) {
        next.delete(entityId);
      } else {
        next.add(entityId);
      }
      return next;
    });
  }, []);

  const toggleExportAll = useCallback(() => {
    setExportSelected((prev) => {
      if (prev.size === mappingsList.length) {
        return new Set();
      }
      return new Set(mappingsList.map((m) => m.entityId));
    });
  }, [mappingsList]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      try {
        const text = await file.text();
        const profile = JSON.parse(text) as MappingProfile;

        if (!profile.version || !profile.entries) {
          setError(t("mapping.invalidProfile"));
          return;
        }

        const entityIds = [
          ...new Set([
            ...bridgeEntityIds,
            ...(mappings?.mappings ?? []).map((m) => m.entityId),
          ]),
        ];
        const preview = await previewMappingProfileImport(
          bridgeId,
          profile,
          entityIds,
        );

        setImportProfile(profile);
        setImportPreview(preview);
        setImportSelected(
          new Set(preview.matches.map((m) => m.matchedEntityId)),
        );
      } catch {
        setError(t("mapping.parseProfileFailed"));
      }
    },
    [bridgeId, bridgeEntityIds, mappings, t],
  );

  const handleImportApply = useCallback(async () => {
    if (!importProfile) return;
    setImporting(true);
    try {
      const result = await applyMappingProfileImport(bridgeId, importProfile, [
        ...importSelected,
      ]);
      setImportPreview(null);
      setImportProfile(null);
      setImportSelected(new Set());
      setSuccessMsg(
        [
          t("mapping.imported", { count: result.applied }),
          result.skipped > 0 &&
            t("mapping.importSkipped", { count: result.skipped }),
          result.errors.length > 0 &&
            t("mapping.importErrors", { count: result.errors.length }),
        ]
          .filter(Boolean)
          .join(", "),
      );
      await loadMappings();
    } catch {
      setError(t("mapping.applyProfileFailed"));
    } finally {
      setImporting(false);
    }
  }, [bridgeId, importProfile, importSelected, loadMappings, t]);

  const handleImportCancel = useCallback(() => {
    setImportPreview(null);
    setImportProfile(null);
    setImportSelected(new Set());
  }, []);

  const toggleImportEntity = useCallback((entityId: string) => {
    setImportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entityId)) {
        next.delete(entityId);
      } else {
        next.add(entityId);
      }
      return next;
    });
  }, []);

  return (
    <Card>
      <CardContent>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          mb={2}
        >
          <Typography variant="h6">
            <SettingsIcon sx={{ mr: 1, verticalAlign: "middle" }} />
            {t("mapping.title")}
          </Typography>
          <Stack direction="row" spacing={1}>
            {mappingsList.length > 0 && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<UploadIcon />}
                onClick={handleExportClick}
              >
                {t("common.export")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="small"
              startIcon={<DownloadIcon />}
              onClick={handleImportClick}
            >
              {t("common.import")}
            </Button>
            <Button variant="outlined" size="small" onClick={handleAddMapping}>
              {t("mapping.addMapping")}
            </Button>
          </Stack>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={handleFileSelected}
          />
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {successMsg && (
          <Alert
            severity="success"
            sx={{ mb: 2 }}
            icon={<CheckCircleIcon />}
            onClose={() => setSuccessMsg(null)}
          >
            {successMsg}
          </Alert>
        )}

        {loading && (
          <Typography color="text.secondary">
            {t("common.loading")}...
          </Typography>
        )}

        {!loading && mappingsList.length === 0 && (
          <Typography color="text.secondary">
            {t("mapping.noMappings")}
          </Typography>
        )}

        {!loading && mappingsList.length > 0 && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("mapping.entityId")}</TableCell>
                  <TableCell>{t("mapping.deviceType")}</TableCell>
                  <TableCell>{t("mapping.customName")}</TableCell>
                  <TableCell>{t("mapping.status")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {mappingsList.map((config) => (
                  <TableRow key={config.entityId}>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {config.entityId}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {config.matterDeviceType || (
                        <Typography color="text.secondary" variant="body2">
                          {t("mapping.auto")}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {config.customName || (
                        <Typography color="text.secondary" variant="body2">
                          -
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      {config.disabled ? (
                        <Chip
                          label={t("common.disabled")}
                          color="error"
                          size="small"
                        />
                      ) : (
                        <Chip
                          label={t("common.enabled")}
                          color="success"
                          size="small"
                        />
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        onClick={() =>
                          handleEditMapping(config.entityId, config)
                        }
                        aria-label={`${t("mapping.editMapping")}: ${config.entityId}`}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => setPendingDelete(config.entityId)}
                        aria-label={`${t("mapping.deleteMapping")}: ${config.entityId}`}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("mapping.deleteMapping")}
        message={t("mapping.confirmDeleteMessage", {
          entityId: pendingDelete ?? "",
        })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          if (pendingDelete) handleDeleteMapping(pendingDelete);
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {editingEntity && (
        <EntityMappingDialog
          open={dialogOpen}
          entityId={editingEntity.entityId}
          domain={editingEntity.domain}
          currentMapping={editingEntity.config}
          onSave={handleSave}
          onClose={handleClose}
        />
      )}

      <Dialog
        open={exportDialogOpen}
        onClose={handleExportCancel}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t("mapping.exportProfile")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label={t("mapping.profileName")}
              size="small"
              fullWidth
              value={exportProfileName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setExportProfileName(e.target.value)
              }
            />
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={exportSelected.size === mappingsList.length}
                        indeterminate={
                          exportSelected.size > 0 &&
                          exportSelected.size < mappingsList.length
                        }
                        onChange={toggleExportAll}
                      />
                    </TableCell>
                    <TableCell>{t("mapping.entityId")}</TableCell>
                    <TableCell>{t("mapping.deviceType")}</TableCell>
                    <TableCell>{t("mapping.customName")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mappingsList.map((config) => (
                    <TableRow key={config.entityId}>
                      <TableCell padding="checkbox">
                        <Checkbox
                          size="small"
                          checked={exportSelected.has(config.entityId)}
                          onChange={() => toggleExportEntity(config.entityId)}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontFamily="monospace">
                          {config.entityId}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {config.matterDeviceType || (
                          <Typography color="text.secondary" variant="body2">
                            {t("mapping.auto")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {config.customName || (
                          <Typography color="text.secondary" variant="body2">
                            -
                          </Typography>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleExportCancel}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            onClick={handleExportConfirm}
            disabled={exportSelected.size === 0}
            startIcon={<UploadIcon />}
          >
            {t("common.export")} {exportSelected.size}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={!!importPreview}
        onClose={handleImportCancel}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t("mapping.importProfile")}</DialogTitle>
        <DialogContent>
          {importPreview && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {t("mapping.importSummary", {
                  name: importPreview.profileName,
                  count: importPreview.totalEntries,
                  matched: importPreview.matches.length,
                })}
              </Typography>

              {importPreview.matches.length > 0 && (
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell padding="checkbox" />
                        <TableCell>{t("mapping.entityId")}</TableCell>
                        <TableCell>{t("mapping.match")}</TableCell>
                        <TableCell>{t("mapping.deviceType")}</TableCell>
                        <TableCell>{t("mapping.existing")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {importPreview.matches.map((match) => (
                        <TableRow key={match.matchedEntityId}>
                          <TableCell padding="checkbox">
                            <Checkbox
                              size="small"
                              checked={importSelected.has(
                                match.matchedEntityId,
                              )}
                              onChange={() =>
                                toggleImportEntity(match.matchedEntityId)
                              }
                            />
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" fontFamily="monospace">
                              {match.matchedEntityId}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={match.matchType}
                              size="small"
                              color={
                                match.matchType === "exact"
                                  ? "success"
                                  : "default"
                              }
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell>
                            {match.entry.matterDeviceType || t("mapping.auto")}
                          </TableCell>
                          <TableCell>
                            {match.existingMapping ? (
                              <Chip
                                label={t("common.overwrite")}
                                size="small"
                                color="warning"
                                variant="outlined"
                              />
                            ) : (
                              <Chip
                                label={t("common.new")}
                                size="small"
                                color="info"
                                variant="outlined"
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}

              {importPreview.unmatchedEntries.length > 0 && (
                <Alert severity="info">
                  {t("mapping.unmatchedEntries", {
                    count: importPreview.unmatchedEntries.length,
                  })}
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleImportCancel}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            onClick={handleImportApply}
            disabled={importing || importSelected.size === 0}
          >
            {importing
              ? t("mapping.applying")
              : t("mapping.applyCount", { count: importSelected.size })}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
