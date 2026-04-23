import {
  type ComposedSubEntity,
  type CustomServiceArea,
  domainToDefaultMatterTypes,
  type EntityMappingConfig,
  type MatterDeviceType,
  matterDeviceTypeLabels,
  RvcCleanModeModeTag,
} from "@home-assistant-matter-hub/common";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutlineOutlined";
import DeleteIcon from "@mui/icons-material/Delete";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EntityAutocomplete } from "./EntityAutocomplete.tsx";

interface RelatedButton {
  entity_id: string;
  friendly_name?: string;
  clean_name: string;
}

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
  const { t } = useTranslation();
  const [editEntityId, setEditEntityId] = useState(entityId);
  const [matterDeviceType, setMatterDeviceType] = useState<
    MatterDeviceType | ""
  >("");
  const [customName, setCustomName] = useState("");
  const [customProductName, setCustomProductName] = useState("");
  const [customVendorName, setCustomVendorName] = useState("");
  const [customSerialNumber, setCustomSerialNumber] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [filterLifeEntity, setFilterLifeEntity] = useState("");
  const [cleaningModeEntity, setCleaningModeEntity] = useState("");
  const [temperatureEntity, setTemperatureEntity] = useState("");
  const [humidityEntity, setHumidityEntity] = useState("");
  const [pressureEntity, setPressureEntity] = useState("");
  const [batteryEntity, setBatteryEntity] = useState("");
  const [roomEntities, setRoomEntities] = useState<string[]>([]);
  const [disableLockPin, setDisableLockPin] = useState(false);
  const [powerEntity, setPowerEntity] = useState("");
  const [energyEntity, setEnergyEntity] = useState("");
  const [suctionLevelEntity, setSuctionLevelEntity] = useState("");
  const [mopIntensityEntity, setMopIntensityEntity] = useState("");
  const [currentRoomEntity, setCurrentRoomEntity] = useState("");
  const [customServiceAreas, setCustomServiceAreas] = useState<
    CustomServiceArea[]
  >([]);
  const [valetudoIdentifier, setValetudoIdentifier] = useState("");
  const [coverSwapOpenClose, setCoverSwapOpenClose] = useState(false);
  const composedKeyRef = useRef(0);
  const [composedEntities, setComposedEntities] = useState<
    (ComposedSubEntity & { _key: number })[]
  >([]);
  const [availableButtons, setAvailableButtons] = useState<RelatedButton[]>([]);
  const [loadingButtons, setLoadingButtons] = useState(false);

  const isNewMapping = !entityId;
  const [customFanSpeedTagsList, setCustomFanSpeedTagsList] = useState<
    { option: string; tag: number }[]
  >([]);

  const availableModeTags = useMemo(() => {
    return Object.entries(RvcCleanModeModeTag)
      .filter(
        ([_, value]) =>
          typeof value === "number" &&
          value !== RvcCleanModeModeTag.Vacuum &&
          value !== RvcCleanModeModeTag.Mop &&
          value !== RvcCleanModeModeTag.VacuumThenMop,
      )
      .map(([key, value]) => ({ label: key, value: value as number }));
  }, []);

  useEffect(() => {
    if (open) {
      setEditEntityId(entityId);
      setMatterDeviceType(currentMapping?.matterDeviceType || "");
      setCustomName(currentMapping?.customName || "");
      setCustomProductName(currentMapping?.customProductName || "");
      setCustomVendorName(currentMapping?.customVendorName || "");
      setCustomSerialNumber(currentMapping?.customSerialNumber || "");
      setDisabled(currentMapping?.disabled || false);
      setFilterLifeEntity(currentMapping?.filterLifeEntity || "");
      setCleaningModeEntity(currentMapping?.cleaningModeEntity || "");
      setTemperatureEntity(currentMapping?.temperatureEntity || "");
      setHumidityEntity(currentMapping?.humidityEntity || "");
      setPressureEntity(currentMapping?.pressureEntity || "");
      setBatteryEntity(currentMapping?.batteryEntity || "");
      setRoomEntities(currentMapping?.roomEntities || []);
      setDisableLockPin(currentMapping?.disableLockPin || false);
      setPowerEntity(currentMapping?.powerEntity || "");
      setEnergyEntity(currentMapping?.energyEntity || "");
      setSuctionLevelEntity(currentMapping?.suctionLevelEntity || "");
      setMopIntensityEntity(currentMapping?.mopIntensityEntity || "");
      setCurrentRoomEntity(currentMapping?.currentRoomEntity || "");
      setCustomServiceAreas(currentMapping?.customServiceAreas || []);
      setValetudoIdentifier(currentMapping?.valetudoIdentifier || "");
      setCoverSwapOpenClose(currentMapping?.coverSwapOpenClose || false);
      composedKeyRef.current = 0;
      setComposedEntities(
        (currentMapping?.composedEntities || []).map((e) => ({
          ...e,
          _key: composedKeyRef.current++,
        })),
      );
      setAvailableButtons([]);
      setCustomFanSpeedTagsList(
        Object.entries(currentMapping?.customFanSpeedTags || {}).map(
          ([option, tag]) => ({ option, tag: tag as number }),
        ),
      );
    }
  }, [open, entityId, currentMapping]);

  // Load available button entities for vacuum domain
  useEffect(() => {
    if (!open || !entityId || domain !== "vacuum") {
      return;
    }

    const loadButtons = async () => {
      setLoadingButtons(true);
      try {
        const response = await fetch(
          `api/home-assistant/related-buttons/${encodeURIComponent(entityId)}`,
        );
        if (response.ok) {
          const data = await response.json();
          setAvailableButtons(data.buttons || []);
        }
      } catch (error) {
        console.error("Failed to load related buttons:", error);
      } finally {
        setLoadingButtons(false);
      }
    };

    loadButtons();
  }, [open, entityId, domain]);

  const currentDomain = editEntityId.split(".")[0] || domain;

  const handleSave = useCallback(() => {
    if (!editEntityId.trim()) return;
    const customFanSpeedTags = customFanSpeedTagsList.reduce(
      (acc, curr) => {
        if (curr.option.trim()) {
          acc[curr.option.trim()] = curr.tag;
        }
        return acc;
      },
      {} as Record<string, number>,
    );
    onSave({
      entityId: editEntityId.trim(),
      matterDeviceType: matterDeviceType || undefined,
      customName: customName.trim() || undefined,
      customProductName: customProductName.trim() || undefined,
      customVendorName: customVendorName.trim() || undefined,
      customSerialNumber: customSerialNumber.trim() || undefined,
      disabled,
      filterLifeEntity: filterLifeEntity.trim() || undefined,
      cleaningModeEntity: cleaningModeEntity.trim() || undefined,
      temperatureEntity: temperatureEntity.trim() || undefined,
      humidityEntity: humidityEntity.trim() || undefined,
      pressureEntity: pressureEntity.trim() || undefined,
      batteryEntity: batteryEntity.trim() || undefined,
      roomEntities: roomEntities.length > 0 ? roomEntities : undefined,
      customServiceAreas:
        customServiceAreas.length > 0 ? customServiceAreas : undefined,
      disableLockPin: disableLockPin || undefined,
      powerEntity: powerEntity.trim() || undefined,
      energyEntity: energyEntity.trim() || undefined,
      suctionLevelEntity: suctionLevelEntity.trim() || undefined,
      mopIntensityEntity: mopIntensityEntity.trim() || undefined,
      currentRoomEntity: currentRoomEntity.trim() || undefined,
      customFanSpeedTags:
        Object.keys(customFanSpeedTags).length > 0
          ? customFanSpeedTags
          : undefined,
      valetudoIdentifier: valetudoIdentifier.trim() || undefined,
      coverSwapOpenClose: coverSwapOpenClose || undefined,
      composedEntities:
        composedEntities.filter((e) => e.entityId?.trim()).length > 0
          ? composedEntities
              .filter((e) => e.entityId?.trim())
              .map(({ _key: _, ...rest }) => rest)
          : undefined,
    });
  }, [
    editEntityId,
    matterDeviceType,
    customName,
    customProductName,
    customVendorName,
    customSerialNumber,
    disabled,
    filterLifeEntity,
    cleaningModeEntity,
    temperatureEntity,
    humidityEntity,
    pressureEntity,
    batteryEntity,
    roomEntities,
    disableLockPin,
    powerEntity,
    energyEntity,
    suctionLevelEntity,
    mopIntensityEntity,
    currentRoomEntity,
    customServiceAreas,
    customFanSpeedTagsList,
    valetudoIdentifier,
    coverSwapOpenClose,
    composedEntities,
    onSave,
  ]);

  // Show filter life entity field for air purifiers (fan domain or explicit air_purifier type)
  const showFilterLifeField =
    matterDeviceType === "air_purifier" ||
    (currentDomain === "fan" && !matterDeviceType);

  // Show cleaning mode entity field for vacuums
  const showCleaningModeField = currentDomain === "vacuum";

  // Show Valetudo identifier field for Valetudo vacuums
  const showValetudoIdentifierField =
    currentDomain === "vacuum" && editEntityId.startsWith("vacuum.valetudo_");

  // Show room entities field for vacuums (Roborock room selection)
  const showRoomEntitiesField = currentDomain === "vacuum";

  // Show humidity/battery entity fields for temperature sensors
  const showHumidityBatteryFields =
    matterDeviceType === "temperature_sensor" ||
    (currentDomain === "sensor" && !matterDeviceType);

  // Show temperature/humidity entity fields for air purifiers (manual sensor mapping)
  const showAirPurifierSensorFields = matterDeviceType === "air_purifier";

  // Show swap open/close option for covers
  const showCoverSwapField =
    matterDeviceType === "window_covering" || currentDomain === "cover";

  // Show PIN disable option for locks
  const showLockPinField =
    matterDeviceType === "door_lock" || currentDomain === "lock";

  // Show power/energy entity fields for switches, lights, and plugs
  const showEnergyFields =
    currentDomain === "switch" ||
    currentDomain === "light" ||
    matterDeviceType === "on_off_plugin_unit" ||
    matterDeviceType === "on_off_switch" ||
    matterDeviceType === "dimmable_plugin_unit";

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
        {isNewMapping
          ? t("mapping.addMapping")
          : `${t("common.edit")}: ${entityId}`}
      </DialogTitle>
      <DialogContent>
        {isNewMapping && (
          <EntityAutocomplete
            value={editEntityId}
            onChange={setEditEntityId}
            label="Entity ID"
            placeholder="light.living_room"
            helperText="Search or enter the Home Assistant entity ID (e.g., light.living_room)"
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
              <em>{t("mapping.autoDetect")}</em>
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

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.customProductName")}
          value={customProductName}
          onChange={(e) => setCustomProductName(e.target.value)}
          helperText={t("mapping.customProductNameHelp")}
        />

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.customVendorName")}
          value={customVendorName}
          onChange={(e) => setCustomVendorName(e.target.value)}
          helperText={t("mapping.customVendorNameHelp")}
        />

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.customSerialNumber")}
          value={customSerialNumber}
          onChange={(e) => setCustomSerialNumber(e.target.value)}
          helperText={t("mapping.customSerialNumberHelp")}
        />

        {showFilterLifeField && (
          <EntityAutocomplete
            value={filterLifeEntity}
            onChange={setFilterLifeEntity}
            label="Filter Life Sensor (optional)"
            placeholder="sensor.air_purifier_filter_life"
            helperText="Sensor entity that provides filter life percentage (0-100%) for HEPA filter monitoring"
            domain="sensor"
          />
        )}

        {showCleaningModeField && (
          <>
            <EntityAutocomplete
              value={cleaningModeEntity}
              onChange={setCleaningModeEntity}
              label="Cleaning Mode Entity (optional)"
              placeholder="select.vacuum_cleaning_mode"
              helperText="Select entity that controls the vacuum cleaning mode (e.g., select.r2_d2_cleaning_mode for Dreame vacuums)"
              domain="select"
            />
            <EntityAutocomplete
              value={suctionLevelEntity}
              onChange={setSuctionLevelEntity}
              label="Suction Level Entity (optional)"
              placeholder="select.vacuum_suction_level"
              helperText="Select entity that controls suction level. Adds Quiet/Max intensity options to Apple Home's extra features panel."
              domain="select"
            />
            <EntityAutocomplete
              value={mopIntensityEntity}
              onChange={setMopIntensityEntity}
              label="Mop Intensity Entity (optional)"
              placeholder="select.vacuum_mop_pad_humidity"
              helperText="Select entity that controls mop water level / intensity. Adds intensity options when mopping in Apple Home."
              domain="select"
            />
            <EntityAutocomplete
              value={currentRoomEntity}
              onChange={setCurrentRoomEntity}
              label="Current Room Entity (optional)"
              placeholder="sensor.vacuum_current_room"
              helperText="Sensor that reports which room the vacuum is currently in (e.g. Dreame current_room sensor). Enables dynamic room progress tracking during multi-room cleaning."
              domain="sensor"
            />
            {showValetudoIdentifierField && (
              <TextField
                fullWidth
                margin="normal"
                label="Valetudo MQTT Identifier (optional)"
                placeholder="GentleFinishedSpider"
                value={valetudoIdentifier}
                onChange={(e) => setValetudoIdentifier(e.target.value)}
                helperText="Exact identifier from Valetudo Connectivity → MQTT. Only needed if it differs from the lowercase entity ID."
              />
            )}
            <Box sx={{ mt: 2, mb: 1 }}>
              <Typography variant="subtitle2" gutterBottom>
                Custom Tag Mapping
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 1, display: "block" }}
              >
                Map home assistant speeds to matter tags. When configured these
                will override default speeds.
              </Typography>
              {customFanSpeedTagsList.map((mapping, index) => (
                <Box
                  key={`${mapping.option}-${mapping.tag}`}
                  sx={{
                    display: "flex",
                    gap: 1,
                    mb: 1,
                    alignItems: "flex-start",
                  }}
                >
                  <TextField
                    size="small"
                    label="HA Option (e.g. Max+)"
                    value={mapping.option}
                    onChange={(e) => {
                      const updated = [...customFanSpeedTagsList];
                      updated[index] = { ...mapping, option: e.target.value };
                      setCustomFanSpeedTagsList(updated);
                    }}
                  />
                  <FormControl size="small" sx={{ flex: 1 }}>
                    <InputLabel>Matter Tag</InputLabel>
                    <Select
                      value={mapping.tag}
                      label="Matter Tag"
                      onChange={(e) => {
                        const updated = [...customFanSpeedTagsList];
                        updated[index] = { ...mapping, tag: e.target.value };
                        setCustomFanSpeedTagsList(updated);
                      }}
                    >
                      {availableModeTags.map((tag) => (
                        <MenuItem key={tag.value} value={tag.value}>
                          {tag.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => {
                      setCustomFanSpeedTagsList(
                        customFanSpeedTagsList.filter((_, i) => i !== index),
                      );
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              ))}
              <Button
                size="small"
                startIcon={<AddCircleOutlineIcon />}
                onClick={() =>
                  setCustomFanSpeedTagsList([
                    ...customFanSpeedTagsList,
                    { option: "", tag: RvcCleanModeModeTag.Auto },
                  ])
                }
              >
                Add Tag Mapping
              </Button>
            </Box>
          </>
        )}

        {showRoomEntitiesField && customServiceAreas.length === 0 && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Room Button Entities (Roborock)
            </Typography>
            <Autocomplete
              multiple
              options={availableButtons}
              getOptionLabel={(option) =>
                typeof option === "string"
                  ? option
                  : option.friendly_name || option.clean_name
              }
              value={availableButtons.filter((btn) =>
                roomEntities.includes(btn.entity_id),
              )}
              onChange={(_, newValue) => {
                setRoomEntities(
                  newValue.map((v) =>
                    typeof v === "string" ? v : v.entity_id,
                  ),
                );
              }}
              loading={loadingButtons}
              freeSolo
              // MUI v5+ does not support renderTags prop directly; use default tag rendering or migrate to slotProps if needed
              renderInput={(params: any) => (
                <TextField
                  {...params}
                  variant="outlined"
                  placeholder={
                    loadingButtons
                      ? "Loading buttons..."
                      : "Select room buttons or type entity ID"
                  }
                  helperText="Select button entities that trigger room cleaning (e.g., button.roborock_clean_kitchen). These appear as rooms in Apple Home."
                  // Remove InputProps override for MUI v5+ compatibility
                />
              )}
            />
            {availableButtons.length === 0 && !loadingButtons && (
              <Typography variant="caption" color="text.secondary">
                No button entities found for this device. You can manually enter
                entity IDs.
              </Typography>
            )}
          </Box>
        )}

        {showHumidityBatteryFields && (
          <>
            <EntityAutocomplete
              value={humidityEntity}
              onChange={setHumidityEntity}
              label="Humidity Sensor (optional)"
              placeholder="sensor.h_t_bad_humidity"
              helperText="Combine with a humidity sensor to create a single Temperature+Humidity device"
              domain="sensor"
            />
            <EntityAutocomplete
              value={pressureEntity}
              onChange={setPressureEntity}
              label="Pressure Sensor (optional)"
              placeholder="sensor.h_t_bad_pressure"
              helperText="Combine with a pressure sensor to create a single Temperature+Pressure device"
              domain="sensor"
            />
            <EntityAutocomplete
              value={batteryEntity}
              onChange={setBatteryEntity}
              label="Battery Sensor (optional)"
              placeholder="sensor.h_t_bad_battery"
              helperText="Include battery level from a separate sensor entity"
              domain="sensor"
            />
          </>
        )}

        {showAirPurifierSensorFields && (
          <>
            <EntityAutocomplete
              value={temperatureEntity}
              onChange={setTemperatureEntity}
              label="Temperature Sensor (optional)"
              placeholder="sensor.air_purifier_temperature"
              helperText="Add temperature measurement to this air purifier from a separate sensor entity"
              domain="sensor"
            />
            <EntityAutocomplete
              value={humidityEntity}
              onChange={setHumidityEntity}
              label="Humidity Sensor (optional)"
              placeholder="sensor.air_purifier_humidity"
              helperText="Add humidity measurement to this air purifier from a separate sensor entity"
              domain="sensor"
            />
          </>
        )}

        {showEnergyFields && (
          <>
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label="Power Sensor (optional)"
              placeholder="sensor.smart_plug_power"
              helperText="Sensor with device_class: power (W) — adds real-time power measurement to this device"
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label="Energy Sensor (optional)"
              placeholder="sensor.smart_plug_energy"
              helperText="Sensor with device_class: energy (kWh) — adds cumulative energy measurement to this device"
              domain="sensor"
            />
          </>
        )}

        {showRoomEntitiesField && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Custom Service Areas
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 1, display: "block" }}
            >
              Define custom zones mapped to HA service calls. Works for lawn
              mowers, pool cleaners, or any zone-based robot. When configured,
              these replace auto-detected rooms.
            </Typography>
            {customServiceAreas.map((area, index) => (
              <Box
                key={`area-${area.name || index}`}
                sx={{
                  display: "flex",
                  gap: 1,
                  mb: 1,
                  alignItems: "flex-start",
                }}
              >
                <TextField
                  size="small"
                  label="Name"
                  value={area.name}
                  onChange={(e) => {
                    const updated = [...customServiceAreas];
                    updated[index] = { ...area, name: e.target.value };
                    setCustomServiceAreas(updated);
                  }}
                  sx={{ flex: 1 }}
                />
                <TextField
                  size="small"
                  label="Service"
                  placeholder="script.start_zone"
                  value={area.service}
                  onChange={(e) => {
                    const updated = [...customServiceAreas];
                    updated[index] = { ...area, service: e.target.value };
                    setCustomServiceAreas(updated);
                  }}
                  sx={{ flex: 1 }}
                />
                <TextField
                  size="small"
                  label="Target (optional)"
                  placeholder="button.zone_1"
                  value={area.target || ""}
                  onChange={(e) => {
                    const updated = [...customServiceAreas];
                    updated[index] = {
                      ...area,
                      target: e.target.value || undefined,
                    };
                    setCustomServiceAreas(updated);
                  }}
                  sx={{ flex: 1 }}
                />
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => {
                    setCustomServiceAreas(
                      customServiceAreas.filter((_, i) => i !== index),
                    );
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
            <Button
              size="small"
              startIcon={<AddCircleOutlineIcon />}
              onClick={() =>
                setCustomServiceAreas([
                  ...customServiceAreas,
                  { name: "", service: "" },
                ])
              }
            >
              Add Area
            </Button>
          </Box>
        )}

        {showCoverSwapField && (
          <FormControlLabel
            control={
              <Switch
                checked={coverSwapOpenClose}
                onChange={(e) => setCoverSwapOpenClose(e.target.checked)}
              />
            }
            label="Swap open/close commands (for awnings and similar covers)"
            sx={{ mt: 1, display: "block" }}
          />
        )}

        {showLockPinField && (
          <FormControlLabel
            control={
              <Switch
                checked={disableLockPin}
                onChange={(e) => setDisableLockPin(e.target.checked)}
              />
            }
            label="Disable PIN requirement for this lock"
            sx={{ mt: 1, display: "block" }}
          />
        )}

        <Box sx={{ mt: 2, mb: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            Composed Sub-Entities
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mb: 1, display: "block" }}
          >
            Group additional HA entities into this device. Each entity becomes a
            sub-endpoint under a shared Matter device. Requires the
            autoComposedDevices feature flag.
          </Typography>
          {composedEntities.map((sub, index) => (
            <Box
              key={sub._key}
              sx={{
                display: "flex",
                gap: 1,
                mb: 1,
                alignItems: "flex-start",
              }}
            >
              <Box sx={{ flex: 2 }}>
                <EntityAutocomplete
                  value={sub.entityId}
                  onChange={(val) => {
                    const updated = [...composedEntities];
                    updated[index] = { ...sub, entityId: val };
                    setComposedEntities(updated);
                  }}
                  label="Entity ID"
                  placeholder="sensor.temperature"
                />
              </Box>
              <FormControl size="small" sx={{ flex: 1, mt: 1 }}>
                <InputLabel>Device Type</InputLabel>
                <Select
                  value={sub.matterDeviceType || ""}
                  label="Device Type"
                  onChange={(e) => {
                    const updated = [...composedEntities];
                    updated[index] = {
                      ...sub,
                      matterDeviceType:
                        (e.target.value as MatterDeviceType) || undefined,
                    };
                    setComposedEntities(updated);
                  }}
                >
                  <MenuItem value="">
                    <em>Auto-detect</em>
                  </MenuItem>
                  {(
                    Object.entries(matterDeviceTypeLabels) as [
                      MatterDeviceType,
                      string,
                    ][]
                  ).map(([key, label]) => (
                    <MenuItem key={key} value={key}>
                      {label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <IconButton
                size="small"
                color="error"
                sx={{ mt: 1.5 }}
                onClick={() => {
                  setComposedEntities(
                    composedEntities.filter((_, i) => i !== index),
                  );
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Box>
          ))}
          <Button
            size="small"
            startIcon={<AddCircleOutlineIcon />}
            onClick={() =>
              setComposedEntities([
                ...composedEntities,
                { entityId: "", _key: composedKeyRef.current++ },
              ])
            }
          >
            Add Sub-Entity
          </Button>
        </Box>

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
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={!editEntityId.trim()}
        >
          {t("common.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
