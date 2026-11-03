import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import SaveIcon from "@mui/icons-material/Save";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  deleteLockCredential,
  fetchLockCredentials,
  type SanitizedCredential,
  toggleLockCredentialEnabled,
  updateLockCredential,
} from "../../api/lock-credentials.ts";
import { EntityAutocomplete } from "../../components/entity-mapping/EntityAutocomplete.tsx";
import { ConfirmDialog } from "../../components/misc/ConfirmDialog.tsx";

interface CredentialDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (entityId: string, pinCode: string, name: string) => Promise<void>;
  initialEntityId?: string;
  initialName?: string;
  isEdit?: boolean;
}

const CredentialDialog = ({
  open,
  onClose,
  onSave,
  initialEntityId = "",
  initialName = "",
  isEdit = false,
}: CredentialDialogProps) => {
  const { t } = useTranslation();
  const [entityId, setEntityId] = useState(initialEntityId);
  const [pinCode, setPinCode] = useState("");
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEntityId(initialEntityId);
      setName(initialName);
      setPinCode("");
      setError("");
    }
  }, [open, initialEntityId, initialName]);

  const handleSave = async () => {
    if (!entityId.trim()) {
      setError(t("lockCredentials.entityRequired"));
      return;
    }
    if (!pinCode || pinCode.length < 4 || pinCode.length > 8) {
      setError(t("lockCredentials.pinLength"));
      return;
    }
    if (!/^\d+$/.test(pinCode)) {
      setError(t("lockCredentials.pinDigitsOnly"));
      return;
    }

    setSaving(true);
    try {
      await onSave(entityId.trim(), pinCode, name.trim());
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("lockCredentials.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {isEdit
          ? t("lockCredentials.editCredential")
          : t("lockCredentials.addCredential")}
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {isEdit ? (
            <TextField
              label={t("lockCredentials.lockEntityId")}
              value={entityId}
              disabled
              fullWidth
              helperText={t("lockCredentials.lockEntityHelperText")}
            />
          ) : (
            <EntityAutocomplete
              value={entityId}
              onChange={setEntityId}
              label={t("lockCredentials.lockEntityId")}
              placeholder="lock.front_door"
              helperText={t("lockCredentials.lockEntityHelperText")}
              domain="lock"
              margin="none"
            />
          )}
          <TextField
            label={t("lockCredentials.pinCode")}
            type="password"
            placeholder="1234"
            value={pinCode}
            onChange={(e) =>
              setPinCode(e.target.value.replace(/\D/g, "").slice(0, 8))
            }
            fullWidth
            helperText={t("lockCredentials.pinHelperText")}
            inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
          />
          <TextField
            label={t("lockCredentials.nameOptional")}
            placeholder={t("lockCredentials.namePlaceholder")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            helperText={t("lockCredentials.nameHelperText")}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          {t("common.cancel")}
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
        >
          {t("common.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export const LockCredentialsPage = () => {
  const { t } = useTranslation();
  const [credentials, setCredentials] = useState<SanitizedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editCredential, setEditCredential] =
    useState<SanitizedCredential | null>(null);

  const loadCredentials = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchLockCredentials();
      setCredentials(response.credentials);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("lockCredentials.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const handleSave = async (
    entityId: string,
    pinCode: string,
    name: string,
  ) => {
    await updateLockCredential(entityId, {
      entityId,
      pinCode,
      // an empty name clears it, a PIN change keeps the enabled switch
      name,
      enabled:
        credentials.find((c) => c.entityId === entityId)?.enabled ?? true,
    });
    await loadCredentials();
  };

  const [pendingDeleteEntity, setPendingDeleteEntity] = useState<string | null>(
    null,
  );

  const handleDelete = async (entityId: string) => {
    setPendingDeleteEntity(null);
    try {
      await deleteLockCredential(entityId);
      await loadCredentials();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("lockCredentials.deleteFailed"),
      );
    }
  };

  const handleToggleEnabled = async (credential: SanitizedCredential) => {
    try {
      await toggleLockCredentialEnabled(
        credential.entityId,
        !credential.enabled,
      );
      await loadCredentials();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("lockCredentials.updateFailed"),
      );
    }
  };

  const handleEdit = (credential: SanitizedCredential) => {
    setEditCredential(credential);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditCredential(null);
    setDialogOpen(true);
  };

  return (
    <Box sx={{ p: 2 }}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 3,
        }}
      >
        <Typography variant="h5" component="h1">
          <LockIcon sx={{ mr: 1, verticalAlign: "middle" }} />
          {t("lockCredentials.title")}
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleAdd}>
          {t("lockCredentials.addCredential")}
        </Button>
      </Box>

      <Alert severity="info" sx={{ mb: 3 }}>
        {t("lockCredentials.info")}
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : credentials.length === 0 ? (
        <Card>
          <CardContent sx={{ textAlign: "center", py: 4 }}>
            <LockIcon sx={{ fontSize: 48, color: "text.secondary", mb: 2 }} />
            <Typography variant="h6" color="text.secondary">
              {t("lockCredentials.empty")}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t("lockCredentials.emptyHint")}
            </Typography>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={handleAdd}
            >
              {t("lockCredentials.addFirst")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <List>
            {credentials.map((credential, index) => (
              <ListItem
                key={credential.entityId}
                divider={index < credentials.length - 1}
                disablePadding
                sx={{ "& > .MuiListItemButton-root": { pr: 15 } }}
                secondaryAction={
                  <Stack direction="row" alignItems="center" spacing={1}>
                    <Tooltip
                      title={
                        credential.enabled
                          ? t("lockCredentials.disable")
                          : t("lockCredentials.enable")
                      }
                    >
                      <Switch
                        checked={credential.enabled}
                        onChange={() => handleToggleEnabled(credential)}
                        slotProps={{
                          input: {
                            "aria-label": `${t("common.enabled")}: ${credential.name || credential.entityId}`,
                          },
                        }}
                      />
                    </Tooltip>
                    <Tooltip title={t("common.delete")}>
                      <IconButton
                        edge="end"
                        onClick={() =>
                          setPendingDeleteEntity(credential.entityId)
                        }
                        aria-label={`${t("common.delete")}: ${credential.name || credential.entityId}`}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                }
              >
                <ListItemButton onClick={() => handleEdit(credential)}>
                  <ListItemIcon>
                    <LockIcon
                      color={credential.enabled ? "primary" : "disabled"}
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary={credential.name || credential.entityId}
                    secondary={
                      <>
                        {credential.name && (
                          <Typography
                            component="span"
                            variant="body2"
                            color="text.secondary"
                          >
                            {credential.entityId}
                          </Typography>
                        )}
                        <Typography
                          component="span"
                          variant="body2"
                          color="text.secondary"
                          sx={{ ml: credential.name ? 2 : 0 }}
                        >
                          {t("lockCredentials.pinMasked")}
                        </Typography>
                      </>
                    }
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </Card>
      )}

      <CredentialDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        initialEntityId={editCredential?.entityId}
        initialName={editCredential?.name}
        isEdit={!!editCredential}
      />
      <ConfirmDialog
        open={pendingDeleteEntity !== null}
        title={t("lockCredentials.confirmDeleteTitle")}
        message={t("lockCredentials.confirmDeleteMessage", {
          entity: pendingDeleteEntity ?? "",
        })}
        confirmLabel={t("common.delete")}
        confirmColor="error"
        onConfirm={() => {
          if (pendingDeleteEntity) handleDelete(pendingDeleteEntity);
        }}
        onCancel={() => setPendingDeleteEntity(null)}
      />
    </Box>
  );
};
