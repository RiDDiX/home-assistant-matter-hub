import type {
  EntityMappingConfig,
  MatterDeviceType,
} from "@home-assistant-matter-hub/common";
import {
  domainToDefaultMatterTypes,
  matterDeviceTypeLabels,
} from "@home-assistant-matter-hub/common";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import { useCallback, useEffect, useState } from "react";

interface EntityMappingDialogProps {
  open: boolean;
  entityId: string;
  domain: string;
  currentMapping?: EntityMappingConfig;
  onSave: (config: Partial<EntityMappingConfig>) => void;
  onClose: () => void;
}

export function EntityMappingDialog({
  open,
  entityId,
  domain,
  currentMapping,
  onSave,
  onClose,
}: EntityMappingDialogProps) {
  const [editEntityId, setEditEntityId] = useState(entityId);
  const [matterDeviceType, setMatterDeviceType] = useState<
    MatterDeviceType | ""
  >("");
  const [customName, setCustomName] = useState("");
  const [disabled, setDisabled] = useState(false);

  const isNewMapping = !entityId;

  useEffect(() => {
    if (open) {
      setEditEntityId(entityId);
      setMatterDeviceType(currentMapping?.matterDeviceType || "");
      setCustomName(currentMapping?.customName || "");
      setDisabled(currentMapping?.disabled || false);
    }
  }, [open, entityId, currentMapping]);

  const currentDomain = editEntityId.split(".")[0] || domain;

  const handleSave = useCallback(() => {
    if (!editEntityId.trim()) return;
    onSave({
      entityId: editEntityId.trim(),
      matterDeviceType: matterDeviceType || undefined,
      customName: customName.trim() || undefined,
      disabled,
    });
  }, [editEntityId, matterDeviceType, customName, disabled, onSave]);

  const availableTypes = Object.entries(matterDeviceTypeLabels) as [
    MatterDeviceType,
    string,
  ][];
  const suggestedTypes =
    domainToDefaultMatterTypes[
      currentDomain as keyof typeof domainToDefaultMatterTypes
    ] || [];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {isNewMapping ? "Add Entity Mapping" : `Edit: ${entityId}`}
      </DialogTitle>
      <DialogContent>
        {isNewMapping && (
          <TextField
            fullWidth
            margin="normal"
            label="Entity ID"
            placeholder="light.living_room"
            value={editEntityId}
            onChange={(e) => setEditEntityId(e.target.value)}
            helperText="Enter the Home Assistant entity ID (e.g., light.living_room)"
            required
          />
        )}
        <FormControl fullWidth margin="normal">
          <InputLabel id="matter-device-type-label">
            Matter Device Type
          </InputLabel>
          <Select
            labelId="matter-device-type-label"
            value={matterDeviceType}
            label="Matter Device Type"
            onChange={(e) =>
              setMatterDeviceType(e.target.value as MatterDeviceType | "")
            }
          >
            <MenuItem value="">
              <em>Auto-detect (default)</em>
            </MenuItem>
            {suggestedTypes.length > 0 && (
              <MenuItem disabled>— Suggested for {domain} —</MenuItem>
            )}
            {suggestedTypes.map((type: MatterDeviceType) => (
              <MenuItem key={type} value={type}>
                {matterDeviceTypeLabels[type]}
              </MenuItem>
            ))}
            {suggestedTypes.length > 0 && (
              <MenuItem disabled>— All types —</MenuItem>
            )}
            {availableTypes
              .filter(([key]) => !suggestedTypes.includes(key))
              .map(([key, label]) => (
                <MenuItem key={key} value={key}>
                  {label}
                </MenuItem>
              ))}
          </Select>
        </FormControl>

        <TextField
          fullWidth
          margin="normal"
          label="Custom Name"
          placeholder={entityId}
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          helperText="Override the entity name shown in Matter controllers"
        />

        <FormControlLabel
          control={
            <Switch
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
          }
          label="Disable this entity (exclude from bridge)"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={!editEntityId.trim()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
