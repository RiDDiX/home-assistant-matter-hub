import type { BridgeIconType } from "@home-assistant-matter-hub/common";
import CloudUpload from "@mui/icons-material/CloudUpload";
import Delete from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkBridgeIconExists,
  deleteBridgeIcon,
  getBridgeIconUrl,
  uploadBridgeIcon,
} from "../../api/bridge-icons";

const ICON_OPTIONS: { value: BridgeIconType | ""; label: string }[] = [
  { value: "", label: "Auto (based on domain/name)" },
  { value: "light", label: "💡 Light" },
  { value: "switch", label: "🔌 Switch" },
  { value: "climate", label: "🌡️ Climate" },
  { value: "cover", label: "🪟 Cover" },
  { value: "fan", label: "🌀 Fan" },
  { value: "lock", label: "🔒 Lock" },
  { value: "sensor", label: "📊 Sensor" },
  { value: "media_player", label: "📺 Media Player" },
  { value: "vacuum", label: "🧹 Vacuum" },
  { value: "remote", label: "🎮 Remote" },
  { value: "humidifier", label: "💧 Humidifier" },
  { value: "speaker", label: "🔊 Speaker" },
  { value: "garage", label: "🚗 Garage" },
  { value: "door", label: "🚪 Door" },
  { value: "window", label: "🪟 Window" },
  { value: "motion", label: "🏃 Motion" },
  { value: "battery", label: "🔋 Battery" },
  { value: "power", label: "⚡ Power" },
  { value: "camera", label: "📷 Camera" },
  { value: "default", label: "🔗 Default" },
];

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
  const fileInputRef = useRef<HTMLInputElement>(null);
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
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      }
    },
    [bridgeId, onIconChange],
  );

  const handleDeleteCustomIcon = useCallback(async () => {
    if (!bridgeId) return;

    setError(null);
    try {
      await deleteBridgeIcon(bridgeId);
      setHasCustomIcon(false);
      setCustomIconUrl(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }, [bridgeId]);

  const handleIconSelectChange = useCallback(
    (value: string) => {
      onIconChange(value === "" ? undefined : (value as BridgeIconType));
    },
    [onIconChange],
  );

  return (
    <Stack spacing={2}>
      <FormControl fullWidth size="small">
        <InputLabel id="icon-select-label">Bridge Icon</InputLabel>
        <Select
          labelId="icon-select-label"
          value={selectedIcon ?? ""}
          label="Bridge Icon"
          onChange={(e) => handleIconSelectChange(e.target.value)}
          disabled={hasCustomIcon}
        >
          {ICON_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {option.label}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>
          {hasCustomIcon
            ? "Custom icon is set. Delete it to use preset icons."
            : "Select a preset icon or upload a custom image"}
        </FormHelperText>
      </FormControl>

      {bridgeId && (
        <Box>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Custom Icon
          </Typography>

          <Stack direction="row" spacing={2} alignItems="center">
            {hasCustomIcon && customIconUrl && (
              <Box
                component="img"
                src={customIconUrl}
                alt="Custom bridge icon"
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
              {uploading ? "Uploading..." : "Upload Image"}
            </Button>

            {hasCustomIcon && (
              <Button
                variant="outlined"
                size="small"
                color="error"
                startIcon={<Delete />}
                onClick={handleDeleteCustomIcon}
              >
                Delete
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
            Supported formats: PNG, JPG, GIF, WebP, SVG (max 5MB)
          </Typography>
        </Box>
      )}

      {!bridgeId && (
        <Typography variant="body2" color="text.secondary">
          Save the bridge first to upload a custom icon.
        </Typography>
      )}
    </Stack>
  );
};
