import type { BridgeIconType } from "@home-assistant-matter-hub/common";
import CloudUpload from "@mui/icons-material/CloudUpload";
import Delete from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkBridgeIconExists,
  deleteBridgeIcon,
  getBridgeIconUrl,
  uploadBridgeIcon,
} from "../../api/bridge-icons";
import { ConfirmDialog } from "../misc/ConfirmDialog.tsx";
import { iconTypeMap } from "./bridgeIconUtils.ts";

const ICON_TYPES = Object.keys(iconTypeMap) as BridgeIconType[];

export interface BridgeIconUploadProps {
  bridgeId?: string;
  selectedIcon?: BridgeIconType | "";
  onIconChange: (icon: BridgeIconType | undefined) => void;
}

export const BridgeIconUpload = ({
  bridgeId,
  selectedIcon,
  onIconChange,
}: BridgeIconUploadProps) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasCustomIcon, setHasCustomIcon] = useState(false);
  const [customIconUrl, setCustomIconUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (bridgeId) {
      checkBridgeIconExists(bridgeId)
        .then((exists) => {
          setHasCustomIcon(exists);
          if (exists) {
            setCustomIconUrl(`${getBridgeIconUrl(bridgeId)}?t=${Date.now()}`);
          }
        })
        .catch(() => {
          // Icon doesn't exist or API error - ignore
          setHasCustomIcon(false);
        });
    }
  }, [bridgeId]);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !bridgeId) return;

      setError(null);
      setUploading(true);

      try {
        await uploadBridgeIcon(bridgeId, file);
        setHasCustomIcon(true);
        setCustomIconUrl(`${getBridgeIconUrl(bridgeId)}?t=${Date.now()}`);
        onIconChange(undefined);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("bridgeIcon.uploadFailed"),
        );
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [bridgeId, onIconChange, t],
  );

  const handleDeleteCustomIcon = useCallback(async () => {
    setConfirmDelete(false);
    if (!bridgeId) return;

    setError(null);
    try {
      await deleteBridgeIcon(bridgeId);
      setHasCustomIcon(false);
      setCustomIconUrl(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("bridgeIcon.deleteFailed"),
      );
    }
  }, [bridgeId, t]);

  const handleIconSelectChange = useCallback(
    (value: string) => {
      onIconChange(value === "" ? undefined : (value as BridgeIconType));
    },
    [onIconChange],
  );

  return (
    <Stack spacing={2}>
      <FormControl fullWidth size="small">
        <InputLabel id="icon-select-label">{t("bridge.iconLabel")}</InputLabel>
        <Select
          labelId="icon-select-label"
          value={selectedIcon ?? ""}
          label={t("bridge.iconLabel")}
          onChange={(e) => handleIconSelectChange(e.target.value)}
          disabled={hasCustomIcon}
          sx={{
            "& .MuiSelect-select": { display: "flex", alignItems: "center" },
          }}
        >
          <MenuItem value="">
            <ListItemText>{t("bridgeIcon.auto")}</ListItemText>
          </MenuItem>
          {ICON_TYPES.map((type) => {
            const Icon = iconTypeMap[type];
            return (
              <MenuItem key={type} value={type}>
                <ListItemIcon>
                  <Icon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t(`bridgeIcon.types.${type}`)}</ListItemText>
              </MenuItem>
            );
          })}
        </Select>
        <FormHelperText>
          {hasCustomIcon
            ? t("bridgeIcon.customSetHint")
            : t("bridgeIcon.selectHint")}
        </FormHelperText>
      </FormControl>

      {bridgeId && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            {t("bridgeIcon.customIcon")}
          </Typography>

          <Stack direction="row" spacing={2} alignItems="center">
            {hasCustomIcon && customIconUrl && (
              <Box
                component="img"
                src={customIconUrl}
                alt={t("bridgeIcon.customIcon")}
                sx={{
                  width: 48,
                  height: 48,
                  objectFit: "contain",
                  borderRadius: 1,
                  border: "1px solid",
                  borderColor: "divider",
                }}
              />
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />

            <Button
              variant="outlined"
              size="small"
              startIcon={<CloudUpload />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? t("bridgeIcon.uploading") : t("bridgeIcon.upload")}
            </Button>

            {hasCustomIcon && (
              <Button
                variant="outlined"
                size="small"
                color="error"
                startIcon={<Delete />}
                onClick={() => setConfirmDelete(true)}
              >
                {t("common.delete")}
              </Button>
            )}
          </Stack>

          {error && (
            <Typography variant="caption" color="error" sx={{ mt: 1 }}>
              {error}
            </Typography>
          )}

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mt: 1, display: "block" }}
          >
            {t("bridgeIcon.formats")} {t("bridgeIcon.appliesImmediately")}
          </Typography>
        </Box>
      )}

      {!bridgeId && (
        <Typography variant="body2" color="text.secondary">
          {t("bridgeIcon.saveFirst")}
        </Typography>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={t("bridgeIcon.deleteTitle")}
        message={t("bridgeIcon.deleteMessage")}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={handleDeleteCustomIcon}
        onCancel={() => setConfirmDelete(false)}
      />
    </Stack>
  );
};
