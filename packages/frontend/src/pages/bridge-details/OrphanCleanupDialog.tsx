import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cleanupOrphans,
  getOrphans,
  type OrphanCandidate,
  type OrphanCleanupResult,
} from "../../api/bridges.ts";

export interface OrphanCleanupDialogProps {
  readonly open: boolean;
  readonly bridgeId: string;
  readonly onClose: () => void;
}

export function OrphanCleanupDialog({
  open,
  bridgeId,
  onClose,
}: OrphanCleanupDialogProps) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<OrphanCandidate[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<OrphanCleanupResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    setResults(null);
    getOrphans(bridgeId)
      .then((res) => {
        if (!active) return;
        setCandidates(res.candidates);
        // All rows checked by default.
        setChecked(new Set(res.candidates.map((c) => c.identityKey)));
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, bridgeId]);

  const toggle = useCallback((key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await cleanupOrphans(bridgeId, [...checked]);
      setResults(res.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [bridgeId, checked]);

  const formatDate = (iso: string) => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
  };

  const deletedCount = results?.filter((r) => r.deleted).length ?? 0;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("bridge.orphanTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {t("bridge.orphanDescription")}
        </DialogContentText>

        {loading && (
          <Box display="flex" justifyContent="center" sx={{ py: 3 }}>
            <CircularProgress />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {!loading && results != null && (
          <>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("bridge.orphanDoneSummary", {
                deleted: deletedCount,
                total: results.length,
              })}
            </Typography>
            <List dense>
              {results.map((r) => (
                <ListItem key={r.identityKey} sx={{ py: 0 }}>
                  <ListItemText
                    primary={r.identityKey}
                    secondary={
                      r.deleted
                        ? t("bridge.orphanResultDeleted")
                        : `${t("bridge.orphanResultSkipped")}${
                            r.reason ? `: ${r.reason}` : ""
                          }`
                    }
                  />
                </ListItem>
              ))}
            </List>
          </>
        )}

        {!loading && results == null && candidates.length === 0 && !error && (
          <Typography variant="body2" color="textSecondary">
            {t("bridge.orphanEmpty")}
          </Typography>
        )}

        {!loading && results == null && candidates.length > 0 && (
          <List dense>
            {candidates.map((c) => (
              <ListItem key={c.identityKey} disablePadding>
                <ListItemButton
                  onClick={() => toggle(c.identityKey)}
                  dense
                  disabled={running}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>
                    <Checkbox
                      edge="start"
                      checked={checked.has(c.identityKey)}
                      tabIndex={-1}
                      disableRipple
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={c.lastEntityId}
                    secondary={t("bridge.orphanMissingSince", {
                      date: formatDate(c.missingSince),
                    })}
                  />
                  {c.hasMapping && (
                    <Chip
                      size="small"
                      label={t("bridge.orphanHasMapping")}
                      sx={{ ml: 1 }}
                    />
                  )}
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={running}>
          {results != null ? t("common.close") : t("common.cancel")}
        </Button>
        {results == null && candidates.length > 0 && (
          <Button
            onClick={handleConfirm}
            color="warning"
            variant="contained"
            disabled={running || checked.size === 0}
            startIcon={
              running ? (
                <CircularProgress size={16} color="inherit" />
              ) : undefined
            }
          >
            {t("bridge.orphanConfirm", { count: checked.size })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
