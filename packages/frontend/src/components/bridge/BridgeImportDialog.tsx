import type {
  BridgeExportData,
  BridgeImportPreview,
  BridgeImportPreviewItem,
} from "@home-assistant-matter-hub/common";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { importBridges, previewImport } from "../../api/bridge-export.js";

interface BridgeImportDialogProps {
  open: boolean;
  file: File | null;
  onClose: () => void;
  onImported: () => void;
}

export function BridgeImportDialog({
  open,
  file,
  onClose,
  onImported,
}: BridgeImportDialogProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<
    | (BridgeImportPreview & { migrated?: boolean; sourceVersion?: string })
    | null
  >(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [importData, setImportData] = useState<BridgeExportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) {
      setPreview(null);
      setSelectedIds(new Set());
      setImportData(null);
      setError(null);
      setResult(null);
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string) as BridgeExportData;
        setImportData(data);
        const previewResult = await previewImport(data);
        setPreview(previewResult);
        setSelectedIds(
          new Set(
            previewResult.bridges.map((b: BridgeImportPreviewItem) => b.id),
          ),
        );
      } catch {
        setError(t("bridge.importParseFailed"));
      }
    };
    reader.readAsText(file);
  }, [open, file, t]);

  const handleToggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (preview) {
      setSelectedIds(
        new Set(preview.bridges.map((b: BridgeImportPreviewItem) => b.id)),
      );
    }
  }, [preview]);

  const handleSelectNone = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleImport = useCallback(async () => {
    if (!importData) return;

    setImporting(true);
    try {
      const importResult = await importBridges(importData, {
        bridgeIds: Array.from(selectedIds),
        overwriteExisting,
      });

      const messages: string[] = [];
      if (importResult.imported > 0) {
        messages.push(`${importResult.imported} bridge(s) imported`);
      }
      if (importResult.skipped > 0) {
        messages.push(`${importResult.skipped} skipped (already exist)`);
      }
      if (importResult.errors.length > 0) {
        messages.push(`${importResult.errors.length} failed`);
      }

      setResult(messages.join(", "));
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }, [importData, selectedIds, overwriteExisting, onImported]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("bridge.importTitle")}</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {result && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {result}
          </Alert>
        )}

        {preview && !result && (
          <>
            {preview.migrated && (
              <Alert severity="info" sx={{ mb: 2 }}>
                This export is from an older version ({preview.sourceVersion}).
                Bridges will be migrated to the current format during import.
              </Alert>
            )}

            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Exported on {new Date(preview.exportedAt).toLocaleString()}
              {preview.sourceVersion && !preview.migrated && (
                <> • Format: {preview.sourceVersion}</>
              )}
            </Typography>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <Button size="small" onClick={handleSelectAll}>
                {t("common.selectAll")}
              </Button>
              <Button size="small" onClick={handleSelectNone}>
                {t("common.selectNone")}
              </Button>
            </div>

            <List dense>
              {preview.bridges.map((bridge: BridgeImportPreviewItem) => (
                <ListItem key={bridge.id} disablePadding>
                  <ListItemIcon>
                    <Checkbox
                      edge="start"
                      checked={selectedIds.has(bridge.id)}
                      onChange={() => handleToggle(bridge.id)}
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={bridge.name}
                    secondary={
                      <>
                        Port {bridge.port} • {bridge.entityCount} filter rules
                        {bridge.exists && (
                          <span style={{ color: "orange" }}>
                            {" "}
                            • Already exists
                          </span>
                        )}
                      </>
                    }
                  />
                </ListItem>
              ))}
            </List>

            <FormControlLabel
              control={
                <Switch
                  checked={overwriteExisting}
                  onChange={(e) => setOverwriteExisting(e.target.checked)}
                />
              }
              label={t("bridge.overwriteExisting")}
            />
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>
          {result ? t("common.close") : t("common.cancel")}
        </Button>
        {!result && (
          <Button
            onClick={handleImport}
            variant="contained"
            disabled={importing || selectedIds.size === 0}
          >
            {importing
              ? t("bridge.importing")
              : t("bridge.importCount", { count: selectedIds.size })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
