import {
  type ClimateAutoMode,
  type ComposedSubEntity,
  type CustomServiceArea,
  domainToDefaultMatterTypes,
  type EntityMappingConfig,
  type MatterDeviceType,
  matterDeviceTypeLabels,
  RvcCleanModeModeTag,
} from "@home-assistant-matter-hub/common";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import DeleteIcon from "@mui/icons-material/Delete";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
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
import {
  ControllerSupportChips,
  controllerSupportWarning,
} from "./ControllerSupportChips.tsx";
import { EntityAutocomplete } from "./EntityAutocomplete.tsx";

interface RelatedButton {
  entity_id: string;
  friendly_name?: string;
  clean_name: string;
}

function parseVendorId(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? Number.parseInt(trimmed.slice(2), 16)
      : Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 0xfffe) return undefined;
  return n;
}

// Parses the optional per-area JSON data field. Empty is valid (no data).
// Only plain objects are accepted; arrays and primitives are rejected.
function parseAreaData(raw: string): {
  value?: Record<string, unknown>;
  valid: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { value: undefined, valid: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, valid: true };
    }
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

function parseDebounceMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(5000, Math.round(n));
}

function parseThrottleMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(60000, Math.round(n));
}

function parseUsercodeSlot(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

// PIN length attributes are uint8, the Matter spec keeps them 1..20.
function parsePinLength(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 20) return undefined;
  return n;
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
  const [customVendorId, setCustomVendorId] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [filterLifeEntity, setFilterLifeEntity] = useState("");
  const [cleaningModeEntity, setCleaningModeEntity] = useState("");
  const [temperatureEntity, setTemperatureEntity] = useState("");
  const [humidityEntity, setHumidityEntity] = useState("");
  const [pressureEntity, setPressureEntity] = useState("");
  const [batteryEntity, setBatteryEntity] = useState("");
  const [disableBatteryMapping, setDisableBatteryMapping] = useState(false);
  const [roomEntities, setRoomEntities] = useState<string[]>([]);
  const [disableLockPin, setDisableLockPin] = useState(false);
  const [lockUsercodeService, setLockUsercodeService] = useState("");
  const [lockUsercodeSlot, setLockUsercodeSlot] = useState("");
  const [lockPinMinLength, setLockPinMinLength] = useState("");
  const [lockPinMaxLength, setLockPinMaxLength] = useState("");
  const [powerEntity, setPowerEntity] = useState("");
  const [energyEntity, setEnergyEntity] = useState("");
  const [meterSerialNumber, setMeterSerialNumber] = useState("");
  const [pointOfDelivery, setPointOfDelivery] = useState("");
  const [voltageEntity, setVoltageEntity] = useState("");
  const [currentEntity, setCurrentEntity] = useState("");
  const [batteryPowerEntity, setBatteryPowerEntity] = useState("");
  const [batteryEnergyEntity, setBatteryEnergyEntity] = useState("");
  const [chargingSwitchEntity, setChargingSwitchEntity] = useState("");
  const [currentLimitEntity, setCurrentLimitEntity] = useState("");
  const [suctionLevelEntity, setSuctionLevelEntity] = useState("");
  const [mopIntensityEntity, setMopIntensityEntity] = useState("");
  const [currentRoomEntity, setCurrentRoomEntity] = useState("");
  const [chargingStateEntity, setChargingStateEntity] = useState("");
  const [cleanedAreaEntity, setCleanedAreaEntity] = useState("");
  const [vacuumAscendingRoomOrder, setVacuumAscendingRoomOrder] =
    useState(false);
  const [disableCustomAreaRoomModes, setDisableCustomAreaRoomModes] =
    useState(false);
  const [vacuumRoomSwitches, setVacuumRoomSwitches] = useState(false);
  const [customServiceAreas, setCustomServiceAreas] = useState<
    CustomServiceArea[]
  >([]);
  const [areaDataDrafts, setAreaDataDrafts] = useState<string[]>([]);
  const [valetudoIdentifier, setValetudoIdentifier] = useState("");
  const [coverSwapOpenClose, setCoverSwapOpenClose] = useState(false);
  const [coverExposeAsDimmableLight, setCoverExposeAsDimmableLight] =
    useState(false);
  const [selectExposeAsSwitch, setSelectExposeAsSwitch] = useState(false);
  const [selectSwitchOnOption, setSelectSwitchOnOption] = useState("");
  const [selectSwitchOffOption, setSelectSwitchOffOption] = useState("");
  const [coverSliderDebounceMs, setCoverSliderDebounceMs] = useState("");
  const [fanSliderDebounceMs, setFanSliderDebounceMs] = useState("");
  const [updateThrottleMs, setUpdateThrottleMs] = useState("");
  const [disableClimateOnOff, setDisableClimateOnOff] = useState(false);
  const [disableClimateFanControl, setDisableClimateFanControl] =
    useState(false);
  const [climateKeepModeOnIdle, setClimateKeepModeOnIdle] = useState(false);
  const [climateExposeFan, setClimateExposeFan] = useState(false);
  const [fanRestoreSpeedOnPowerOn, setFanRestoreSpeedOnPowerOn] =
    useState(false);
  const [climateAutoMode, setClimateAutoMode] = useState<ClimateAutoMode | "">(
    "",
  );
  const [disableMomentaryFlip, setDisableMomentaryFlip] = useState(false);
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
  // Comma-separated HA preset names that map to natural / sleep wind (#387)
  const [fanNaturalPresets, setFanNaturalPresets] = useState("");
  const [fanSleepPresets, setFanSleepPresets] = useState("");

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
      setCustomVendorId(
        currentMapping?.customVendorId !== undefined
          ? `0x${currentMapping.customVendorId.toString(16).toUpperCase()}`
          : "",
      );
      setDisabled(currentMapping?.disabled || false);
      setFilterLifeEntity(currentMapping?.filterLifeEntity || "");
      setCleaningModeEntity(currentMapping?.cleaningModeEntity || "");
      setTemperatureEntity(currentMapping?.temperatureEntity || "");
      setHumidityEntity(currentMapping?.humidityEntity || "");
      setPressureEntity(currentMapping?.pressureEntity || "");
      setBatteryEntity(currentMapping?.batteryEntity || "");
      setDisableBatteryMapping(currentMapping?.disableBatteryMapping || false);
      setRoomEntities(currentMapping?.roomEntities || []);
      setDisableLockPin(currentMapping?.disableLockPin || false);
      setLockUsercodeService(currentMapping?.lockUsercodeService || "");
      setLockUsercodeSlot(
        currentMapping?.lockUsercodeSlot != null
          ? String(currentMapping.lockUsercodeSlot)
          : "",
      );
      setLockPinMinLength(
        currentMapping?.lockPinMinLength != null
          ? String(currentMapping.lockPinMinLength)
          : "",
      );
      setLockPinMaxLength(
        currentMapping?.lockPinMaxLength != null
          ? String(currentMapping.lockPinMaxLength)
          : "",
      );
      setPowerEntity(currentMapping?.powerEntity || "");
      setEnergyEntity(currentMapping?.energyEntity || "");
      setMeterSerialNumber(currentMapping?.meterSerialNumber || "");
      setPointOfDelivery(currentMapping?.pointOfDelivery || "");
      setVoltageEntity(currentMapping?.voltageEntity || "");
      setCurrentEntity(currentMapping?.currentEntity || "");
      setBatteryPowerEntity(currentMapping?.batteryPowerEntity || "");
      setBatteryEnergyEntity(currentMapping?.batteryEnergyEntity || "");
      setChargingSwitchEntity(currentMapping?.chargingSwitchEntity || "");
      setCurrentLimitEntity(currentMapping?.currentLimitEntity || "");
      setSuctionLevelEntity(currentMapping?.suctionLevelEntity || "");
      setMopIntensityEntity(currentMapping?.mopIntensityEntity || "");
      setCurrentRoomEntity(currentMapping?.currentRoomEntity || "");
      setChargingStateEntity(currentMapping?.chargingStateEntity || "");
      setCleanedAreaEntity(currentMapping?.cleanedAreaEntity || "");
      setVacuumAscendingRoomOrder(
        currentMapping?.vacuumAscendingRoomOrder || false,
      );
      setDisableCustomAreaRoomModes(
        currentMapping?.disableCustomAreaRoomModes || false,
      );
      setVacuumRoomSwitches(currentMapping?.vacuumRoomSwitches || false);
      setCustomServiceAreas(currentMapping?.customServiceAreas || []);
      setAreaDataDrafts(
        (currentMapping?.customServiceAreas || []).map((a) =>
          a.data ? JSON.stringify(a.data) : "",
        ),
      );
      setValetudoIdentifier(currentMapping?.valetudoIdentifier || "");
      setCoverSwapOpenClose(currentMapping?.coverSwapOpenClose || false);
      setCoverExposeAsDimmableLight(
        currentMapping?.coverExposeAsDimmableLight || false,
      );
      setSelectExposeAsSwitch(currentMapping?.selectExposeAsSwitch || false);
      setSelectSwitchOnOption(currentMapping?.selectSwitchOnOption || "");
      setSelectSwitchOffOption(currentMapping?.selectSwitchOffOption || "");
      setCoverSliderDebounceMs(
        currentMapping?.coverSliderDebounceMs != null
          ? String(currentMapping.coverSliderDebounceMs)
          : "",
      );
      setFanSliderDebounceMs(
        currentMapping?.fanSliderDebounceMs != null
          ? String(currentMapping.fanSliderDebounceMs)
          : "",
      );
      setUpdateThrottleMs(
        currentMapping?.updateThrottleMs != null
          ? String(currentMapping.updateThrottleMs)
          : "",
      );
      setDisableClimateOnOff(currentMapping?.disableClimateOnOff || false);
      setDisableClimateFanControl(
        currentMapping?.disableClimateFanControl || false,
      );
      setClimateKeepModeOnIdle(currentMapping?.climateKeepModeOnIdle || false);
      setClimateExposeFan(currentMapping?.climateExposeFan || false);
      setFanRestoreSpeedOnPowerOn(
        currentMapping?.fanRestoreSpeedOnPowerOn || false,
      );
      setClimateAutoMode(currentMapping?.climateAutoMode || "");
      setDisableMomentaryFlip(currentMapping?.disableMomentaryFlip || false);
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
      setFanNaturalPresets(
        (currentMapping?.fanWindPresets?.natural || []).join(", "),
      );
      setFanSleepPresets(
        (currentMapping?.fanWindPresets?.sleep || []).join(", "),
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
    const splitPresets = (v: string) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const naturalPresets = splitPresets(fanNaturalPresets);
    const sleepPresets = splitPresets(fanSleepPresets);
    const fanWindPresets =
      naturalPresets.length > 0 || sleepPresets.length > 0
        ? {
            natural: naturalPresets.length > 0 ? naturalPresets : undefined,
            sleep: sleepPresets.length > 0 ? sleepPresets : undefined,
          }
        : undefined;
    onSave({
      entityId: editEntityId.trim(),
      matterDeviceType: matterDeviceType || undefined,
      customName: customName.trim() || undefined,
      customProductName: customProductName.trim() || undefined,
      customVendorName: customVendorName.trim() || undefined,
      customSerialNumber: customSerialNumber.trim() || undefined,
      customVendorId: parseVendorId(customVendorId),
      disabled,
      filterLifeEntity: filterLifeEntity.trim() || undefined,
      cleaningModeEntity: cleaningModeEntity.trim() || undefined,
      temperatureEntity: temperatureEntity.trim() || undefined,
      humidityEntity: humidityEntity.trim() || undefined,
      pressureEntity: pressureEntity.trim() || undefined,
      batteryEntity: batteryEntity.trim() || undefined,
      disableBatteryMapping: disableBatteryMapping || undefined,
      roomEntities: roomEntities.length > 0 ? roomEntities : undefined,
      customServiceAreas:
        customServiceAreas.length > 0 ? customServiceAreas : undefined,
      disableLockPin: disableLockPin || undefined,
      lockUsercodeService: lockUsercodeService.trim() || undefined,
      lockUsercodeSlot: parseUsercodeSlot(lockUsercodeSlot),
      lockPinMinLength: parsePinLength(lockPinMinLength),
      lockPinMaxLength: parsePinLength(lockPinMaxLength),
      powerEntity: powerEntity.trim() || undefined,
      energyEntity: energyEntity.trim() || undefined,
      // Only meaningful on the utility meter type; sending them for other
      // types would keep stale values alive in storage and exports.
      meterSerialNumber:
        matterDeviceType === "electrical_utility_meter"
          ? meterSerialNumber.trim() || undefined
          : undefined,
      pointOfDelivery:
        matterDeviceType === "electrical_utility_meter"
          ? pointOfDelivery.trim() || undefined
          : undefined,
      voltageEntity: voltageEntity.trim() || undefined,
      currentEntity: currentEntity.trim() || undefined,
      batteryPowerEntity: batteryPowerEntity.trim() || undefined,
      batteryEnergyEntity: batteryEnergyEntity.trim() || undefined,
      chargingSwitchEntity: chargingSwitchEntity.trim() || undefined,
      currentLimitEntity: currentLimitEntity.trim() || undefined,
      suctionLevelEntity: suctionLevelEntity.trim() || undefined,
      mopIntensityEntity: mopIntensityEntity.trim() || undefined,
      currentRoomEntity: currentRoomEntity.trim() || undefined,
      chargingStateEntity: chargingStateEntity.trim() || undefined,
      cleanedAreaEntity: cleanedAreaEntity.trim() || undefined,
      vacuumAscendingRoomOrder: vacuumAscendingRoomOrder || undefined,
      disableCustomAreaRoomModes: disableCustomAreaRoomModes || undefined,
      vacuumRoomSwitches: vacuumRoomSwitches || undefined,
      customFanSpeedTags:
        Object.keys(customFanSpeedTags).length > 0
          ? customFanSpeedTags
          : undefined,
      fanWindPresets,
      valetudoIdentifier: valetudoIdentifier.trim() || undefined,
      coverSwapOpenClose: coverSwapOpenClose || undefined,
      coverExposeAsDimmableLight: coverExposeAsDimmableLight || undefined,
      selectExposeAsSwitch: selectExposeAsSwitch || undefined,
      selectSwitchOnOption: selectExposeAsSwitch
        ? selectSwitchOnOption.trim() || undefined
        : undefined,
      selectSwitchOffOption: selectExposeAsSwitch
        ? selectSwitchOffOption.trim() || undefined
        : undefined,
      coverSliderDebounceMs: parseDebounceMs(coverSliderDebounceMs),
      fanSliderDebounceMs: parseDebounceMs(fanSliderDebounceMs),
      updateThrottleMs: parseThrottleMs(updateThrottleMs),
      disableClimateOnOff: disableClimateOnOff || undefined,
      disableClimateFanControl: disableClimateFanControl || undefined,
      climateKeepModeOnIdle: climateKeepModeOnIdle || undefined,
      climateExposeFan: climateExposeFan || undefined,
      fanRestoreSpeedOnPowerOn: fanRestoreSpeedOnPowerOn || undefined,
      climateAutoMode: climateAutoMode || undefined,
      disableMomentaryFlip: disableMomentaryFlip || undefined,
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
    customVendorId,
    disabled,
    filterLifeEntity,
    cleaningModeEntity,
    temperatureEntity,
    humidityEntity,
    pressureEntity,
    batteryEntity,
    disableBatteryMapping,
    roomEntities,
    disableLockPin,
    lockUsercodeService,
    lockUsercodeSlot,
    lockPinMinLength,
    lockPinMaxLength,
    powerEntity,
    energyEntity,
    meterSerialNumber,
    pointOfDelivery,
    voltageEntity,
    currentEntity,
    batteryPowerEntity,
    batteryEnergyEntity,
    chargingSwitchEntity,
    currentLimitEntity,
    suctionLevelEntity,
    mopIntensityEntity,
    currentRoomEntity,
    chargingStateEntity,
    cleanedAreaEntity,
    vacuumAscendingRoomOrder,
    disableCustomAreaRoomModes,
    vacuumRoomSwitches,
    customServiceAreas,
    customFanSpeedTagsList,
    fanNaturalPresets,
    fanSleepPresets,
    valetudoIdentifier,
    coverSwapOpenClose,
    coverExposeAsDimmableLight,
    selectExposeAsSwitch,
    selectSwitchOnOption,
    selectSwitchOffOption,
    coverSliderDebounceMs,
    fanSliderDebounceMs,
    updateThrottleMs,
    disableClimateOnOff,
    disableClimateFanControl,
    climateKeepModeOnIdle,
    climateExposeFan,
    fanRestoreSpeedOnPowerOn,
    climateAutoMode,
    disableMomentaryFlip,
    composedEntities,
    onSave,
  ]);

  // Show filter life entity field for air purifiers (fan domain or explicit air_purifier type)
  const showFilterLifeField =
    matterDeviceType === "air_purifier" ||
    (currentDomain === "fan" && !matterDeviceType);

  // Show wind preset mapping for fans (localized natural/sleep names, #387)
  const showFanWindPresetFields =
    currentDomain === "fan" &&
    (!matterDeviceType || matterDeviceType === "fan");

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
  const showSelectSwitchFields =
    currentDomain === "select" || currentDomain === "input_select";

  // Show PIN disable option for locks
  const showLockPinField =
    matterDeviceType === "door_lock" || currentDomain === "lock";

  // Show OnOff disable option for climate entities
  const showClimateOnOffField =
    matterDeviceType === "thermostat" || currentDomain === "climate";

  // Show power/energy entity fields for switches, lights, and plugs
  const showEnergyFields =
    // on_off_switch is exposed as a plain On/Off Light, which carries no
    // power/energy clusters, so don't offer those fields for it (#380).
    matterDeviceType !== "on_off_switch" &&
    // The electrical-meter types render their own companion group below, so
    // don't double up when one of those is picked for a switch/light.
    matterDeviceType !== "electrical_meter" &&
    matterDeviceType !== "solar_power" &&
    matterDeviceType !== "electrical_sensor" &&
    matterDeviceType !== "electrical_utility_meter" &&
    // EVSE renders its own charging switch / current limit / power / energy
    // group below, so don't double up the power/energy fields for it (#419).
    matterDeviceType !== "evse" &&
    (currentDomain === "switch" ||
      currentDomain === "light" ||
      matterDeviceType === "on_off_plugin_unit" ||
      matterDeviceType === "dimmable_plugin_unit");

  // Show the full power/energy/voltage/current group for electrical meters, so
  // one device folds separate sensors into a single ElectricalMeter endpoint.
  const showElectricalMeterFields =
    matterDeviceType === "electrical_meter" ||
    matterDeviceType === "solar_power" ||
    matterDeviceType === "electrical_sensor" ||
    matterDeviceType === "electrical_utility_meter";

  // Show the MeterIdentification fields for the Matter 1.4 utility meter.
  const showUtilityMeterFields =
    matterDeviceType === "electrical_utility_meter";

  // Show battery power/energy fields to expose a home battery as an ESS.
  const showBatteryEnergyFields = matterDeviceType === "battery_storage";

  // Show the EVSE charging switch, current limit and optional power/energy
  // sensors when the entity is mapped as an EV charger.
  const showEvseFields = matterDeviceType === "evse";

  // Show momentary-flip disable option for entities that only pulse on then
  // auto-reset off (no real "on" state to hold), the source of the Echo
  // wedge in #423.
  const showMomentaryFlipField =
    currentDomain === "script" ||
    currentDomain === "scene" ||
    currentDomain === "automation" ||
    currentDomain === "input_button" ||
    currentDomain === "button";

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
            renderValue={(value) =>
              value ? (
                matterDeviceTypeLabels[value as MatterDeviceType]
              ) : (
                <em>{t("mapping.autoDetect")}</em>
              )
            }
          >
            <MenuItem value="">
              <em>{t("mapping.autoDetect")}</em>
            </MenuItem>
            {suggestedTypes.length > 0 && (
              <MenuItem disabled>Suggested for {domain}</MenuItem>
            )}
            {suggestedTypes.map((type: MatterDeviceType) => (
              <MenuItem key={type} value={type}>
                {matterDeviceTypeLabels[type]}
                <ControllerSupportChips type={type} />
              </MenuItem>
            ))}
            {suggestedTypes.length > 0 && (
              <MenuItem disabled>All types</MenuItem>
            )}
            {availableTypes
              .filter(([key]) => !suggestedTypes.includes(key))
              .map(([key, label]) => (
                <MenuItem key={key} value={key}>
                  {label}
                  <ControllerSupportChips type={key} />
                </MenuItem>
              ))}
          </Select>
        </FormControl>
        {matterDeviceType !== "" &&
          controllerSupportWarning(matterDeviceType) && (
            <Alert severity="info" sx={{ mt: 1 }}>
              {controllerSupportWarning(matterDeviceType)}
            </Alert>
          )}

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

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.customVendorId")}
          placeholder="0x115F"
          value={customVendorId}
          onChange={(e) => setCustomVendorId(e.target.value)}
          helperText={t("mapping.customVendorIdHelp")}
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

        {showFanWindPresetFields && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Wind Preset Mapping (optional)
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 1, display: "block" }}
            >
              Map localized preset names to Matter wind modes. Comma-separated
              HA preset names, e.g. 自然风 for natural wind.
            </Typography>
            <TextField
              fullWidth
              margin="normal"
              size="small"
              label="Natural Wind Presets"
              placeholder="自然风, Natural"
              value={fanNaturalPresets}
              onChange={(e) => setFanNaturalPresets(e.target.value)}
            />
            <TextField
              fullWidth
              margin="normal"
              size="small"
              label="Sleep Wind Presets"
              placeholder="睡眠风, Sleep"
              value={fanSleepPresets}
              onChange={(e) => setFanSleepPresets(e.target.value)}
            />
          </Box>
        )}

        {currentDomain === "fan" && (
          <FormControlLabel
            control={
              <Switch
                checked={fanRestoreSpeedOnPowerOn}
                onChange={(e) => setFanRestoreSpeedOnPowerOn(e.target.checked)}
              />
            }
            label="Restore the last fan speed when turned on (Apple Home's power button injects 100%). Only a 100% or High command while off is treated as power-on; lower speeds set while off are kept, so you cannot start an off fan at full speed."
            sx={{ mt: 1, display: "block" }}
          />
        )}

        {(currentDomain === "fan" || currentDomain === "climate") && (
          <TextField
            label="Fan slider debounce (ms)"
            type="number"
            size="small"
            value={fanSliderDebounceMs}
            onChange={(e) => setFanSliderDebounceMs(e.target.value)}
            helperText="Wait this long after the last inbound fan-speed write before sending it to Home Assistant. Controllers stream writes while a slider is dragged; on IR or UART bridged ACs every write makes the unit beep. 0 / empty uses the bridge setting (default off). Try 1000-2000. Max 5000."
            slotProps={{ htmlInput: { min: 0, max: 5000, step: 50 } }}
            sx={{ mt: 1, display: "block" }}
          />
        )}

        {showSelectSwitchFields && (
          <>
            <FormControlLabel
              control={
                <Switch
                  checked={selectExposeAsSwitch}
                  onChange={(e) => setSelectExposeAsSwitch(e.target.checked)}
                />
              }
              label="Expose as an on/off switch (controllers can't render select options over Matter). On and off each pick one option below. Re-pair after changing."
              sx={{ mt: 1, display: "block" }}
            />
            {selectExposeAsSwitch && (
              <Box sx={{ display: "flex", gap: 2, mt: 1 }}>
                <TextField
                  label="Option for ON"
                  size="small"
                  value={selectSwitchOnOption}
                  onChange={(e) => setSelectSwitchOnOption(e.target.value)}
                  helperText="Exact option text"
                />
                <TextField
                  label="Option for OFF"
                  size="small"
                  value={selectSwitchOffOption}
                  onChange={(e) => setSelectSwitchOffOption(e.target.value)}
                  helperText="Exact option text"
                />
              </Box>
            )}
          </>
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
            <EntityAutocomplete
              value={chargingStateEntity}
              onChange={setChargingStateEntity}
              label="Charging State Entity (optional)"
              placeholder="sensor.vacuum_charging_state"
              helperText="Sensor reporting the charging state (e.g. Xiaomi charging_state: charging / not_charging / full). Drives the Matter charge state directly instead of inferring it from docked + battery level."
              domain="sensor"
            />
            <EntityAutocomplete
              value={cleanedAreaEntity}
              onChange={setCleanedAreaEntity}
              label="Cleaned Area Sensor (m², optional)"
              placeholder="sensor.vacuum_cleaned_area"
              helperText="Sensor reporting cumulative cleaned area in m². With a Size (m²) set on each area, advances room progress for batch vacuums that report area but not the current room."
              domain="sensor"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={vacuumAscendingRoomOrder}
                  onChange={(e) =>
                    setVacuumAscendingRoomOrder(e.target.checked)
                  }
                />
              }
              label="Vacuum cleans rooms in ascending area ID order, not in the order they were picked (Roborock batch cleaning). Fixes the room shown as current and the room progress when the picking order differs."
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={disableCustomAreaRoomModes}
                  onChange={(e) =>
                    setDisableCustomAreaRoomModes(e.target.checked)
                  }
                />
              }
              label="Don't expose custom areas as per-room cleaning modes (forces Apple Home to use the multi-room area picker). Keep off for Google Home / Alexa, which rely on the modes."
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={vacuumRoomSwitches}
                  onChange={(e) => setVacuumRoomSwitches(e.target.checked)}
                />
              }
              label="Expose one momentary switch per area next to the vacuum, so platforms that can't send multi-room commands (e.g. SmartThings routines) can start cleaning a single area by turning its switch on."
              sx={{ mt: 1, display: "block" }}
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
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    label={
                      typeof option === "string"
                        ? option
                        : option.friendly_name || option.clean_name
                    }
                    size="small"
                    {...getTagProps({ index })}
                    key={typeof option === "string" ? option : option.entity_id}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  variant="outlined"
                  placeholder={
                    loadingButtons
                      ? "Loading buttons..."
                      : "Select room buttons or type entity ID"
                  }
                  helperText="Select button entities that trigger room cleaning (e.g., button.roborock_clean_kitchen). These appear as rooms in Apple Home."
                  InputProps={{
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {loadingButtons ? (
                          <CircularProgress color="inherit" size={20} />
                        ) : null}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  }}
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
              helperText="Sensor with device_class: power (W), adds real-time power measurement to this device"
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label="Energy Sensor (optional)"
              placeholder="sensor.smart_plug_energy"
              helperText="Sensor with device_class: energy (kWh), adds cumulative energy measurement to this device"
              domain="sensor"
            />
            <EntityAutocomplete
              value={voltageEntity}
              onChange={setVoltageEntity}
              label="Voltage Sensor (optional)"
              placeholder="sensor.smart_plug_voltage"
              helperText="Sensor with device_class: voltage (V), folds voltage into the power measurement"
              domain="sensor"
            />
            <EntityAutocomplete
              value={currentEntity}
              onChange={setCurrentEntity}
              label="Current Sensor (optional)"
              placeholder="sensor.smart_plug_current"
              helperText="Sensor with device_class: current (A), folds current into the power measurement"
              domain="sensor"
            />
          </>
        )}

        {showElectricalMeterFields && (
          <>
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label="Power Sensor (optional)"
              placeholder="sensor.grid_power"
              helperText="Sensor with device_class: power (W). Leave empty to use this entity's own value."
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label="Energy Sensor (optional)"
              placeholder="sensor.grid_energy"
              helperText="Sensor with device_class: energy (kWh), adds cumulative energy to this meter"
              domain="sensor"
            />
            <EntityAutocomplete
              value={voltageEntity}
              onChange={setVoltageEntity}
              label="Voltage Sensor (optional)"
              placeholder="sensor.grid_voltage"
              helperText="Sensor with device_class: voltage (V), folded into this meter"
              domain="sensor"
            />
            <EntityAutocomplete
              value={currentEntity}
              onChange={setCurrentEntity}
              label="Current Sensor (optional)"
              placeholder="sensor.grid_current"
              helperText="Sensor with device_class: current (A), folded into this meter"
              domain="sensor"
            />
          </>
        )}

        {showUtilityMeterFields && (
          <>
            <TextField
              fullWidth
              margin="normal"
              label="Meter Serial Number (optional)"
              placeholder="1EMH0001234567"
              value={meterSerialNumber}
              onChange={(e) => setMeterSerialNumber(e.target.value)}
              helperText="Serial number reported via MeterIdentification. Empty reports null."
            />
            <TextField
              fullWidth
              margin="normal"
              label="Point of Delivery (optional)"
              placeholder="DE0001234567890123456789012345678"
              value={pointOfDelivery}
              onChange={(e) => setPointOfDelivery(e.target.value)}
              helperText="Metering point id reported via MeterIdentification. Empty reports null."
            />
          </>
        )}

        {showEvseFields && (
          <>
            <EntityAutocomplete
              value={chargingSwitchEntity}
              onChange={setChargingSwitchEntity}
              label="Charging Switch (optional)"
              placeholder="switch.wallbox_charging"
              helperText="Switch that starts and stops charging. EnableCharging turns it on, Disable turns it off."
              domain="switch"
            />
            <EntityAutocomplete
              value={currentLimitEntity}
              onChange={setCurrentLimitEntity}
              label="Current Limit (optional)"
              placeholder="number.wallbox_current_limit"
              helperText="Number entity (amperes) for the charge current limit. Feeds MaximumChargeCurrent."
              domain="number"
            />
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label="Power Sensor (optional)"
              placeholder="sensor.wallbox_power"
              helperText="Sensor with device_class: power (W), adds real-time power to this charger"
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label="Energy Sensor (optional)"
              placeholder="sensor.wallbox_energy"
              helperText="Sensor with device_class: energy (kWh), adds cumulative energy to this charger"
              domain="sensor"
            />
          </>
        )}

        {showBatteryEnergyFields && (
          <>
            <EntityAutocomplete
              value={batteryPowerEntity}
              onChange={setBatteryPowerEntity}
              label="Battery Power Sensor (optional)"
              placeholder="sensor.home_battery_power"
              helperText="Sensor with device_class: power (W). Positive on discharge, negative on charge. Exposes the battery as an ESS."
              domain="sensor"
            />
            <EntityAutocomplete
              value={batteryEnergyEntity}
              onChange={setBatteryEnergyEntity}
              label="Battery Energy Sensor (optional)"
              placeholder="sensor.home_battery_energy"
              helperText="Sensor with device_class: energy (kWh), adds lifetime throughput to the battery"
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
              these replace auto-detected rooms. Data is extra JSON sent with
              the call. Batch fires one combined call for all selected zones
              instead of one per zone.
            </Typography>
            {customServiceAreas.map((area, index) => {
              const dataValid = parseAreaData(
                areaDataDrafts[index] ?? "",
              ).valid;
              return (
                <Box
                  key={`area-${area.name || index}`}
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    mb: 2,
                  }}
                >
                  <Box
                    sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
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
                        setAreaDataDrafts(
                          areaDataDrafts.filter((_, i) => i !== index),
                        );
                      }}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                    <TextField
                      size="small"
                      label="Data (JSON, optional)"
                      placeholder={'{"segments": [16, 17]}'}
                      value={areaDataDrafts[index] ?? ""}
                      error={!dataValid}
                      helperText={
                        !dataValid ? "Invalid JSON object" : undefined
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const drafts = [...areaDataDrafts];
                        drafts[index] = raw;
                        setAreaDataDrafts(drafts);
                        const { value, valid } = parseAreaData(raw);
                        if (!valid) return;
                        const { data: _, ...rest } = area;
                        const updated = [...customServiceAreas];
                        updated[index] =
                          value === undefined ? rest : { ...rest, data: value };
                        setCustomServiceAreas(updated);
                      }}
                      sx={{ flex: 2 }}
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={area.batchDispatch ?? false}
                          onChange={(e) => {
                            const updated = [...customServiceAreas];
                            updated[index] = {
                              ...area,
                              batchDispatch: e.target.checked || undefined,
                            };
                            setCustomServiceAreas(updated);
                          }}
                        />
                      }
                      label="Batch"
                    />
                    <TextField
                      size="small"
                      type="number"
                      label="Size (m²)"
                      placeholder="20"
                      value={area.sizeSqm != null ? String(area.sizeSqm) : ""}
                      onChange={(e) => {
                        const n = Number.parseFloat(e.target.value);
                        const updated = [...customServiceAreas];
                        updated[index] = {
                          ...area,
                          sizeSqm: Number.isFinite(n) && n > 0 ? n : undefined,
                        };
                        setCustomServiceAreas(updated);
                      }}
                      sx={{ width: 110 }}
                    />
                  </Box>
                </Box>
              );
            })}
            <Button
              size="small"
              startIcon={<AddCircleOutlineIcon />}
              onClick={() => {
                setCustomServiceAreas([
                  ...customServiceAreas,
                  { name: "", service: "" },
                ]);
                setAreaDataDrafts([...areaDataDrafts, ""]);
              }}
            >
              Add Area
            </Button>
          </Box>
        )}

        {showCoverSwapField && (
          <>
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
            <FormControlLabel
              control={
                <Switch
                  checked={coverExposeAsDimmableLight}
                  onChange={(e) =>
                    setCoverExposeAsDimmableLight(e.target.checked)
                  }
                />
              }
              label="Expose as a dimmable light (Alexa workaround: level = open %, on/off = open/close). Keep off for Apple / Google."
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label="Slider debounce (ms)"
              type="number"
              size="small"
              value={coverSliderDebounceMs}
              onChange={(e) => setCoverSliderDebounceMs(e.target.value)}
              helperText="Override for slow blinds. 0 / empty uses bridge setting (default 400/150ms two-phase). Try 800-1500 for sluggish covers. Max 5000."
              slotProps={{ htmlInput: { min: 0, max: 5000, step: 50 } }}
              sx={{ mt: 1, display: "block" }}
            />
          </>
        )}

        {showLockPinField && (
          <>
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
            <TextField
              label="Physical lock usercode service"
              size="small"
              fullWidth
              value={lockUsercodeService}
              onChange={(e) => setLockUsercodeService(e.target.value)}
              helperText="Opt-in: also program the physical lock when a controller sets/clears the PIN, e.g. zwave_js.set_lock_usercode or zha.set_lock_user_code. Leave empty to keep the PIN only in HAMH."
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label="Code slot"
              type="number"
              size="small"
              value={lockUsercodeSlot}
              onChange={(e) => setLockUsercodeSlot(e.target.value)}
              helperText="Code slot on the physical lock, default 1"
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label="Min PIN length"
              type="number"
              size="small"
              value={lockPinMinLength}
              onChange={(e) => setLockPinMinLength(e.target.value)}
              helperText="Override advertised minimum PIN length (1-20). Default 4. Set min = max for locks that require an exact length."
              slotProps={{ htmlInput: { min: 1, max: 20, step: 1 } }}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label="Max PIN length"
              type="number"
              size="small"
              value={lockPinMaxLength}
              onChange={(e) => setLockPinMaxLength(e.target.value)}
              helperText="Override advertised maximum PIN length (1-20). Default 8. Controllers cache both lengths at pairing, re-pair the bridge after changing them."
              slotProps={{ htmlInput: { min: 1, max: 20, step: 1 } }}
              sx={{ mt: 1, display: "block" }}
            />
          </>
        )}

        {showClimateOnOffField && (
          <>
            <FormControlLabel
              control={
                <Switch
                  checked={disableClimateOnOff}
                  onChange={(e) => setDisableClimateOnOff(e.target.checked)}
                />
              }
              label="Disable on/off for this climate entity (keeps the thermostat running when a room is turned off by voice)"
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={disableClimateFanControl}
                  onChange={(e) =>
                    setDisableClimateFanControl(e.target.checked)
                  }
                />
              }
              label="Expose as plain Thermostat (drop FanControl), workaround for controllers like Aqara that don't recognise the air conditioner device type. Needs a full HAMH restart, then re-pair the bridge in the controller (Aqara caches the device list)"
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateKeepModeOnIdle}
                  onChange={(e) => setClimateKeepModeOnIdle(e.target.checked)}
                />
              }
              label="Keep last mode on Matter while off + idle (workaround for ACs that report off + hvac_action=idle during internal cleaning, so the controller's Off button stays actionable)"
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateExposeFan}
                  onChange={(e) => setClimateExposeFan(e.target.checked)}
                />
              }
              label="Expose a companion Fan device (adds a separate Apple Home fan tile for fan_only mode and speed, only for ACs with a fan mode, and re-pairs this AC once)"
              sx={{ mt: 1, display: "block" }}
            />
            <FormControl size="small" sx={{ mt: 1, minWidth: 260 }}>
              <InputLabel id="climate-auto-mode-label">
                Auto mode direction
              </InputLabel>
              <Select
                labelId="climate-auto-mode-label"
                value={climateAutoMode}
                label="Auto mode direction"
                onChange={(e) =>
                  setClimateAutoMode((e.target.value as ClimateAutoMode) || "")
                }
              >
                <MenuItem value="">
                  <em>Auto-detect</em>
                </MenuItem>
                <MenuItem value="cool">Cool</MenuItem>
                <MenuItem value="heat">Heat</MenuItem>
              </Select>
            </FormControl>
          </>
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

        <FormControlLabel
          control={
            <Switch
              checked={disableBatteryMapping}
              onChange={(e) => setDisableBatteryMapping(e.target.checked)}
            />
          }
          label="Disable battery mapping (skip an auto-detected or manually mapped battery sensor for this entity; use when an integration like Xiaomi Home reports a bogus battery sensor on a mains-powered device, causing a false low-battery warning in Matter controllers)"
          sx={{ mt: 1, display: "block" }}
        />

        {showMomentaryFlipField && (
          <FormControlLabel
            control={
              <Switch
                checked={disableMomentaryFlip}
                onChange={(e) => setDisableMomentaryFlip(e.target.checked)}
              />
            }
            label="Do not report the on/off flip after a run. Try this when Alexa devices on script bridges stop responding."
            sx={{ mt: 1, display: "block" }}
          />
        )}

        <TextField
          fullWidth
          margin="normal"
          label="Update throttle (ms, optional)"
          type="number"
          value={updateThrottleMs}
          onChange={(e) => setUpdateThrottleMs(e.target.value)}
          helperText="Limit Matter updates for chatty sensors (power, energy) to one per N ms. Empty / 0 keeps the default. Max 60000."
          slotProps={{ htmlInput: { min: 0, max: 60000, step: 100 } }}
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
