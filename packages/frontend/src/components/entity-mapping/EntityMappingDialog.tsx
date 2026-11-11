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

// Empty clears the value, and so does 0 on the ms fields per their help text.
function isInvalid(
  value: string,
  parse: (value: string) => number | undefined,
  zeroClears = false,
): boolean {
  const trimmed = value.trim();
  if (!trimmed || (zeroClears && Number(trimmed) === 0)) return false;
  return parse(trimmed) === undefined;
}

interface EntityMappingDialogProps {
  open: boolean;
  entityId: string;
  domain: string;
  currentMapping?: EntityMappingConfig;
  onSave: (config: Partial<EntityMappingConfig>) => void | Promise<void>;
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
  const [lockWithoutPin, setLockWithoutPin] = useState(false);
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
  const [faultEntity, setFaultEntity] = useState("");
  const [readinessEntity, setReadinessEntity] = useState("");
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
  const [coverOpenCloseAsPosition, setCoverOpenCloseAsPosition] =
    useState(false);
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
  const [climateForceTurnOn, setClimateForceTurnOn] = useState(false);
  const [climateBlockOff, setClimateBlockOff] = useState(false);
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
  const [saving, setSaving] = useState(false);

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
      setLockWithoutPin(currentMapping?.lockWithoutPin || false);
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
      setFaultEntity(currentMapping?.faultEntity || "");
      setReadinessEntity(currentMapping?.readinessEntity || "");
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
      setCoverOpenCloseAsPosition(
        currentMapping?.coverOpenCloseAsPosition || false,
      );
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
      setClimateForceTurnOn(currentMapping?.climateForceTurnOn || false);
      setClimateBlockOff(currentMapping?.climateBlockOff || false);
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

  const handleSave = useCallback(async () => {
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
    setSaving(true);
    try {
      await onSave({
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
        lockWithoutPin: lockWithoutPin || undefined,
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
        faultEntity: faultEntity.trim() || undefined,
        readinessEntity: readinessEntity.trim() || undefined,
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
        coverOpenCloseAsPosition: coverOpenCloseAsPosition || undefined,
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
        climateForceTurnOn: climateForceTurnOn || undefined,
        climateBlockOff: climateBlockOff || undefined,
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
    } finally {
      setSaving(false);
    }
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
    lockWithoutPin,
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
    faultEntity,
    readinessEntity,
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
    coverOpenCloseAsPosition,
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
    climateForceTurnOn,
    climateBlockOff,
    climateExposeFan,
    fanRestoreSpeedOnPowerOn,
    climateAutoMode,
    disableMomentaryFlip,
    composedEntities,
    onSave,
  ]);

  const vendorIdInvalid = isInvalid(customVendorId, parseVendorId);
  const usercodeSlotInvalid = isInvalid(lockUsercodeSlot, parseUsercodeSlot);
  const pinMinInvalid = isInvalid(lockPinMinLength, parsePinLength);
  const pinMaxInvalid = isInvalid(lockPinMaxLength, parsePinLength);
  const coverDebounceInvalid = isInvalid(
    coverSliderDebounceMs,
    parseDebounceMs,
    true,
  );
  const fanDebounceInvalid = isInvalid(
    fanSliderDebounceMs,
    parseDebounceMs,
    true,
  );
  const throttleInvalid = isInvalid(updateThrottleMs, parseThrottleMs, true);
  // handleSave turns an invalid value into "clear", so it must not run
  const hasInvalidInput =
    vendorIdInvalid ||
    usercodeSlotInvalid ||
    pinMinInvalid ||
    pinMaxInvalid ||
    coverDebounceInvalid ||
    fanDebounceInvalid ||
    throttleInvalid ||
    areaDataDrafts.some((draft) => !parseAreaData(draft).valid);

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
            label={t("mapping.entityId")}
            placeholder="light.living_room"
            helperText={t("mapping.dialog.entityIdHelp")}
          />
        )}
        <FormControl fullWidth margin="normal">
          <InputLabel id="matter-device-type-label">
            {t("mapping.dialog.matterDeviceType")}
          </InputLabel>
          <Select
            labelId="matter-device-type-label"
            value={matterDeviceType}
            label={t("mapping.dialog.matterDeviceType")}
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
              <MenuItem disabled>
                {t("mapping.dialog.suggestedFor", { domain: currentDomain })}
              </MenuItem>
            )}
            {suggestedTypes.map((type: MatterDeviceType) => (
              <MenuItem key={type} value={type}>
                {matterDeviceTypeLabels[type]}
                <ControllerSupportChips type={type} />
              </MenuItem>
            ))}
            {suggestedTypes.length > 0 && (
              <MenuItem disabled>{t("mapping.dialog.allTypes")}</MenuItem>
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
        {currentDomain === "light" &&
          matterDeviceType === "on_off_plugin_unit" && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              {t("mapping.dialog.lightAsOutletWarning")}
            </Alert>
          )}

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.customName")}
          placeholder={entityId}
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          helperText={t("mapping.dialog.customNameHelp")}
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
          error={vendorIdInvalid}
          helperText={t("mapping.customVendorIdHelp")}
        />

        {showFilterLifeField && (
          <EntityAutocomplete
            value={filterLifeEntity}
            onChange={setFilterLifeEntity}
            label={t("mapping.dialog.filterLifeSensor")}
            placeholder="sensor.air_purifier_filter_life"
            helperText={t("mapping.dialog.filterLifeSensorHelp")}
            domain="sensor"
          />
        )}

        {showFanWindPresetFields && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              {t("mapping.dialog.windPresetTitle")}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 1, display: "block" }}
            >
              {t("mapping.dialog.windPresetHelp")}
            </Typography>
            <TextField
              fullWidth
              margin="normal"
              size="small"
              label={t("mapping.dialog.naturalWindPresets")}
              placeholder="自然风, Natural"
              value={fanNaturalPresets}
              onChange={(e) => setFanNaturalPresets(e.target.value)}
            />
            <TextField
              fullWidth
              margin="normal"
              size="small"
              label={t("mapping.dialog.sleepWindPresets")}
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
            label={t("mapping.dialog.fanRestoreSpeed")}
            sx={{ mt: 1, display: "block" }}
          />
        )}

        {(currentDomain === "fan" || currentDomain === "climate") && (
          <TextField
            label={t("mapping.dialog.fanSliderDebounce")}
            type="number"
            size="small"
            value={fanSliderDebounceMs}
            onChange={(e) => setFanSliderDebounceMs(e.target.value)}
            error={fanDebounceInvalid}
            helperText={t("mapping.dialog.fanSliderDebounceHelp")}
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
              label={t("mapping.dialog.selectExposeAsSwitch")}
              sx={{ mt: 1, display: "block" }}
            />
            {selectExposeAsSwitch && (
              <Box sx={{ display: "flex", gap: 2, mt: 1 }}>
                <TextField
                  label={t("mapping.dialog.selectOnOption")}
                  size="small"
                  value={selectSwitchOnOption}
                  onChange={(e) => setSelectSwitchOnOption(e.target.value)}
                  helperText={t("mapping.dialog.exactOptionText")}
                />
                <TextField
                  label={t("mapping.dialog.selectOffOption")}
                  size="small"
                  value={selectSwitchOffOption}
                  onChange={(e) => setSelectSwitchOffOption(e.target.value)}
                  helperText={t("mapping.dialog.exactOptionText")}
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
              label={t("mapping.dialog.cleaningModeEntity")}
              placeholder="select.vacuum_cleaning_mode"
              helperText={t("mapping.dialog.cleaningModeEntityHelp")}
              domain="select"
            />
            <EntityAutocomplete
              value={suctionLevelEntity}
              onChange={setSuctionLevelEntity}
              label={t("mapping.dialog.suctionLevelEntity")}
              placeholder="select.vacuum_suction_level"
              helperText={t("mapping.dialog.suctionLevelEntityHelp")}
              domain="select"
            />
            <EntityAutocomplete
              value={mopIntensityEntity}
              onChange={setMopIntensityEntity}
              label={t("mapping.dialog.mopIntensityEntity")}
              placeholder="select.vacuum_mop_pad_humidity"
              helperText={t("mapping.dialog.mopIntensityEntityHelp")}
              domain="select"
            />
            <EntityAutocomplete
              value={currentRoomEntity}
              onChange={setCurrentRoomEntity}
              label={t("mapping.dialog.currentRoomEntity")}
              placeholder="sensor.vacuum_current_room"
              helperText={t("mapping.dialog.currentRoomEntityHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={faultEntity}
              onChange={setFaultEntity}
              label={t("mapping.dialog.faultEntity")}
              placeholder="sensor.vacuum_error"
              helperText={t("mapping.dialog.faultEntityHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={readinessEntity}
              onChange={setReadinessEntity}
              label={t("mapping.dialog.readinessEntity")}
              placeholder="sensor.roomba_readiness"
              helperText={t("mapping.dialog.readinessEntityHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={chargingStateEntity}
              onChange={setChargingStateEntity}
              label={t("mapping.dialog.chargingStateEntity")}
              placeholder="sensor.vacuum_charging_state"
              helperText={t("mapping.dialog.chargingStateEntityHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={cleanedAreaEntity}
              onChange={setCleanedAreaEntity}
              label={t("mapping.dialog.cleanedAreaEntity")}
              placeholder="sensor.vacuum_cleaned_area"
              helperText={t("mapping.dialog.cleanedAreaEntityHelp")}
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
              label={t("mapping.dialog.vacuumAscendingRoomOrder")}
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
              label={t("mapping.dialog.disableCustomAreaRoomModes")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={vacuumRoomSwitches}
                  onChange={(e) => setVacuumRoomSwitches(e.target.checked)}
                />
              }
              label={t("mapping.dialog.vacuumRoomSwitches")}
              sx={{ mt: 1, display: "block" }}
            />
            {showValetudoIdentifierField && (
              <TextField
                fullWidth
                margin="normal"
                label={t("mapping.dialog.valetudoIdentifier")}
                placeholder="GentleFinishedSpider"
                value={valetudoIdentifier}
                onChange={(e) => setValetudoIdentifier(e.target.value)}
                helperText={t("mapping.dialog.valetudoIdentifierHelp")}
              />
            )}
            <Box sx={{ mt: 2, mb: 1 }}>
              <Typography variant="subtitle2" gutterBottom>
                {t("mapping.dialog.customTagTitle")}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 1, display: "block" }}
              >
                {t("mapping.dialog.customTagHelp")}
              </Typography>
              {customFanSpeedTagsList.map((mapping, index) => (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: a mapping is its position, two may share option and tag
                  key={index}
                  sx={{
                    display: "flex",
                    gap: 1,
                    mb: 1,
                    alignItems: "flex-start",
                  }}
                >
                  <TextField
                    size="small"
                    label={t("mapping.dialog.haOption")}
                    value={mapping.option}
                    onChange={(e) => {
                      const updated = [...customFanSpeedTagsList];
                      updated[index] = { ...mapping, option: e.target.value };
                      setCustomFanSpeedTagsList(updated);
                    }}
                  />
                  <FormControl size="small" sx={{ flex: 1 }}>
                    <InputLabel>{t("mapping.matterTag")}</InputLabel>
                    <Select
                      value={mapping.tag}
                      label={t("mapping.matterTag")}
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
                    aria-label={t("common.delete")}
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
                {t("mapping.dialog.addTagMapping")}
              </Button>
            </Box>
          </>
        )}

        {showRoomEntitiesField && customServiceAreas.length === 0 && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              {t("mapping.dialog.roomButtonsTitle")}
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
                      ? t("mapping.dialog.loadingButtons")
                      : t("mapping.dialog.roomButtonsPlaceholder")
                  }
                  helperText={t("mapping.dialog.roomButtonsHelp")}
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
                {t("mapping.dialog.noRoomButtons")}
              </Typography>
            )}
          </Box>
        )}

        {showHumidityBatteryFields && (
          <>
            <EntityAutocomplete
              value={humidityEntity}
              onChange={setHumidityEntity}
              label={t("mapping.dialog.humiditySensor")}
              placeholder="sensor.h_t_bad_humidity"
              helperText={t("mapping.dialog.humiditySensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={pressureEntity}
              onChange={setPressureEntity}
              label={t("mapping.dialog.pressureSensor")}
              placeholder="sensor.h_t_bad_pressure"
              helperText={t("mapping.dialog.pressureSensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={batteryEntity}
              onChange={setBatteryEntity}
              label={t("mapping.dialog.batterySensor")}
              placeholder="sensor.h_t_bad_battery"
              helperText={t("mapping.dialog.batterySensorHelp")}
              domain="sensor"
            />
          </>
        )}

        {showAirPurifierSensorFields && (
          <>
            <EntityAutocomplete
              value={temperatureEntity}
              onChange={setTemperatureEntity}
              label={t("mapping.dialog.temperatureSensor")}
              placeholder="sensor.air_purifier_temperature"
              helperText={t("mapping.dialog.purifierTemperatureHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={humidityEntity}
              onChange={setHumidityEntity}
              label={t("mapping.dialog.humiditySensor")}
              placeholder="sensor.air_purifier_humidity"
              helperText={t("mapping.dialog.purifierHumidityHelp")}
              domain="sensor"
            />
          </>
        )}

        {showEnergyFields && (
          <>
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label={t("mapping.dialog.powerSensor")}
              placeholder="sensor.smart_plug_power"
              helperText={t("mapping.dialog.powerSensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label={t("mapping.dialog.energySensor")}
              placeholder="sensor.smart_plug_energy"
              helperText={t("mapping.dialog.energySensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={voltageEntity}
              onChange={setVoltageEntity}
              label={t("mapping.dialog.voltageSensor")}
              placeholder="sensor.smart_plug_voltage"
              helperText={t("mapping.dialog.voltageSensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={currentEntity}
              onChange={setCurrentEntity}
              label={t("mapping.dialog.currentSensor")}
              placeholder="sensor.smart_plug_current"
              helperText={t("mapping.dialog.currentSensorHelp")}
              domain="sensor"
            />
          </>
        )}

        {showElectricalMeterFields && (
          <>
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label={t("mapping.dialog.powerSensor")}
              placeholder="sensor.grid_power"
              helperText={t("mapping.dialog.meterPowerHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label={t("mapping.dialog.energySensor")}
              placeholder="sensor.grid_energy"
              helperText={t("mapping.dialog.meterEnergyHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={voltageEntity}
              onChange={setVoltageEntity}
              label={t("mapping.dialog.voltageSensor")}
              placeholder="sensor.grid_voltage"
              helperText={t("mapping.dialog.meterVoltageHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={currentEntity}
              onChange={setCurrentEntity}
              label={t("mapping.dialog.currentSensor")}
              placeholder="sensor.grid_current"
              helperText={t("mapping.dialog.meterCurrentHelp")}
              domain="sensor"
            />
          </>
        )}

        {showUtilityMeterFields && (
          <>
            <TextField
              fullWidth
              margin="normal"
              label={t("mapping.dialog.meterSerialNumber")}
              placeholder="1EMH0001234567"
              value={meterSerialNumber}
              onChange={(e) => setMeterSerialNumber(e.target.value)}
              helperText={t("mapping.dialog.meterSerialNumberHelp")}
            />
            <TextField
              fullWidth
              margin="normal"
              label={t("mapping.dialog.pointOfDelivery")}
              placeholder="DE0001234567890123456789012345678"
              value={pointOfDelivery}
              onChange={(e) => setPointOfDelivery(e.target.value)}
              helperText={t("mapping.dialog.pointOfDeliveryHelp")}
            />
          </>
        )}

        {showEvseFields && (
          <>
            <EntityAutocomplete
              value={chargingSwitchEntity}
              onChange={setChargingSwitchEntity}
              label={t("mapping.dialog.chargingSwitch")}
              placeholder="switch.wallbox_charging"
              helperText={t("mapping.dialog.chargingSwitchHelp")}
              domain="switch"
            />
            <EntityAutocomplete
              value={currentLimitEntity}
              onChange={setCurrentLimitEntity}
              label={t("mapping.dialog.currentLimit")}
              placeholder="number.wallbox_current_limit"
              helperText={t("mapping.dialog.currentLimitHelp")}
              domain="number"
            />
            <EntityAutocomplete
              value={powerEntity}
              onChange={setPowerEntity}
              label={t("mapping.dialog.powerSensor")}
              placeholder="sensor.wallbox_power"
              helperText={t("mapping.dialog.evsePowerHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={energyEntity}
              onChange={setEnergyEntity}
              label={t("mapping.dialog.energySensor")}
              placeholder="sensor.wallbox_energy"
              helperText={t("mapping.dialog.evseEnergyHelp")}
              domain="sensor"
            />
          </>
        )}

        {showBatteryEnergyFields && (
          <>
            <EntityAutocomplete
              value={batteryPowerEntity}
              onChange={setBatteryPowerEntity}
              label={t("mapping.dialog.batteryPowerSensor")}
              placeholder="sensor.home_battery_power"
              helperText={t("mapping.dialog.batteryPowerSensorHelp")}
              domain="sensor"
            />
            <EntityAutocomplete
              value={batteryEnergyEntity}
              onChange={setBatteryEnergyEntity}
              label={t("mapping.dialog.batteryEnergySensor")}
              placeholder="sensor.home_battery_energy"
              helperText={t("mapping.dialog.batteryEnergySensorHelp")}
              domain="sensor"
            />
          </>
        )}

        {showRoomEntitiesField && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              {t("mapping.dialog.customAreasTitle")}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 1, display: "block" }}
            >
              {t("mapping.dialog.customAreasHelp")}
            </Typography>
            {customServiceAreas.map((area, index) => {
              const dataValid = parseAreaData(
                areaDataDrafts[index] ?? "",
              ).valid;
              const hasMap = (a: CustomServiceArea) =>
                typeof a.mapName === "string" && a.mapName.trim() !== "";
              const mapMissing =
                !hasMap(area) && customServiceAreas.some(hasMap);
              return (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: an area is its position, two may share a name
                  key={index}
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
                      label={t("common.name")}
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
                      label={t("mapping.dialog.areaService")}
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
                      label={t("mapping.dialog.areaTarget")}
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
                      aria-label={t("common.delete")}
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
                      label={t("mapping.dialog.areaData")}
                      placeholder={'{"segments": [16, 17]}'}
                      value={areaDataDrafts[index] ?? ""}
                      error={!dataValid}
                      helperText={
                        !dataValid
                          ? t("mapping.dialog.areaDataInvalid")
                          : undefined
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
                      label={t("mapping.dialog.areaBatch")}
                    />
                    <TextField
                      size="small"
                      type="number"
                      label={t("mapping.dialog.areaSize")}
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
                  <Box
                    sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}
                  >
                    <TextField
                      size="small"
                      label={t("mapping.dialog.areaMap")}
                      slotProps={{ htmlInput: { maxLength: 64 } }}
                      value={area.mapName ?? ""}
                      error={mapMissing}
                      helperText={
                        mapMissing
                          ? t("mapping.dialog.areaMapRequired")
                          : undefined
                      }
                      onChange={(e) => {
                        const updated = [...customServiceAreas];
                        updated[index] = {
                          ...area,
                          mapName: e.target.value || undefined,
                        };
                        setCustomServiceAreas(updated);
                      }}
                      sx={{ width: 150 }}
                    />
                    <TextField
                      size="small"
                      type="number"
                      label={t("mapping.dialog.areaFloor")}
                      slotProps={{ htmlInput: { step: 1 } }}
                      value={area.floorNumber ?? ""}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        const updated = [...customServiceAreas];
                        updated[index] = {
                          ...area,
                          floorNumber:
                            Number.isInteger(n) && n >= -32767 && n <= 32767
                              ? n
                              : undefined,
                        };
                        setCustomServiceAreas(updated);
                      }}
                      sx={{ width: 90 }}
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
              {t("mapping.dialog.addArea")}
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
              label={t("mapping.dialog.coverSwapOpenClose")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={coverOpenCloseAsPosition}
                  onChange={(e) =>
                    setCoverOpenCloseAsPosition(e.target.checked)
                  }
                />
              }
              label={t("mapping.dialog.coverOpenCloseAsPosition")}
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
              label={t("mapping.dialog.coverExposeAsDimmableLight")}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label={t("mapping.dialog.coverSliderDebounce")}
              type="number"
              size="small"
              value={coverSliderDebounceMs}
              onChange={(e) => setCoverSliderDebounceMs(e.target.value)}
              error={coverDebounceInvalid}
              helperText={t("mapping.dialog.coverSliderDebounceHelp")}
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
              label={t("mapping.dialog.disableLockPin")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={lockWithoutPin}
                  onChange={(e) => setLockWithoutPin(e.target.checked)}
                />
              }
              label={t("mapping.dialog.lockWithoutPin")}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label={t("mapping.dialog.lockUsercodeService")}
              size="small"
              fullWidth
              value={lockUsercodeService}
              onChange={(e) => setLockUsercodeService(e.target.value)}
              helperText={t("mapping.dialog.lockUsercodeServiceHelp")}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label={t("mapping.dialog.lockUsercodeSlot")}
              type="number"
              size="small"
              value={lockUsercodeSlot}
              onChange={(e) => setLockUsercodeSlot(e.target.value)}
              error={usercodeSlotInvalid}
              helperText={t("mapping.dialog.lockUsercodeSlotHelp")}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label={t("mapping.dialog.lockPinMinLength")}
              type="number"
              size="small"
              value={lockPinMinLength}
              onChange={(e) => setLockPinMinLength(e.target.value)}
              error={pinMinInvalid}
              helperText={t("mapping.dialog.lockPinMinLengthHelp")}
              slotProps={{ htmlInput: { min: 1, max: 20, step: 1 } }}
              sx={{ mt: 1, display: "block" }}
            />
            <TextField
              label={t("mapping.dialog.lockPinMaxLength")}
              type="number"
              size="small"
              value={lockPinMaxLength}
              onChange={(e) => setLockPinMaxLength(e.target.value)}
              error={pinMaxInvalid}
              helperText={t("mapping.dialog.lockPinMaxLengthHelp")}
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
              label={t("mapping.dialog.disableClimateOnOff")}
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
              label={t("mapping.dialog.disableClimateFanControl")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateKeepModeOnIdle}
                  onChange={(e) => setClimateKeepModeOnIdle(e.target.checked)}
                />
              }
              label={t("mapping.dialog.climateKeepModeOnIdle")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateForceTurnOn}
                  onChange={(e) => setClimateForceTurnOn(e.target.checked)}
                />
              }
              label={t("mapping.dialog.climateForceTurnOn")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateBlockOff}
                  onChange={(e) => setClimateBlockOff(e.target.checked)}
                />
              }
              label={t("mapping.dialog.climateBlockOff")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={climateExposeFan}
                  onChange={(e) => setClimateExposeFan(e.target.checked)}
                />
              }
              label={t("mapping.dialog.climateExposeFan")}
              sx={{ mt: 1, display: "block" }}
            />
            <FormControl size="small" sx={{ mt: 1, minWidth: 260 }}>
              <InputLabel id="climate-auto-mode-label">
                {t("mapping.dialog.climateAutoMode")}
              </InputLabel>
              <Select
                labelId="climate-auto-mode-label"
                value={climateAutoMode}
                label={t("mapping.dialog.climateAutoMode")}
                onChange={(e) =>
                  setClimateAutoMode((e.target.value as ClimateAutoMode) || "")
                }
              >
                <MenuItem value="">
                  <em>{t("mapping.autoDetect")}</em>
                </MenuItem>
                <MenuItem value="cool">{t("endpoints.state.cool")}</MenuItem>
                <MenuItem value="heat">{t("endpoints.state.heat")}</MenuItem>
              </Select>
            </FormControl>
          </>
        )}

        <Box sx={{ mt: 2, mb: 1 }}>
          <Typography variant="subtitle2" gutterBottom>
            {t("mapping.dialog.composedTitle")}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ mb: 1, display: "block" }}
          >
            {t("mapping.dialog.composedHelp")}
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
                  label={t("mapping.entityId")}
                  placeholder="sensor.temperature"
                />
              </Box>
              <FormControl size="small" sx={{ flex: 1, mt: 1 }}>
                <InputLabel>{t("mapping.deviceType")}</InputLabel>
                <Select
                  value={sub.matterDeviceType || ""}
                  label={t("mapping.deviceType")}
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
                    <em>{t("mapping.autoDetect")}</em>
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
                aria-label={t("common.delete")}
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
            {t("mapping.dialog.addSubEntity")}
          </Button>
        </Box>

        <FormControlLabel
          control={
            <Switch
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
          }
          label={t("mapping.dialog.disableEntity")}
        />

        <FormControlLabel
          control={
            <Switch
              checked={disableBatteryMapping}
              onChange={(e) => setDisableBatteryMapping(e.target.checked)}
            />
          }
          label={t("mapping.dialog.disableBatteryMapping")}
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
            label={t("mapping.dialog.disableMomentaryFlip")}
            sx={{ mt: 1, display: "block" }}
          />
        )}

        <TextField
          fullWidth
          margin="normal"
          label={t("mapping.dialog.updateThrottle")}
          type="number"
          value={updateThrottleMs}
          onChange={(e) => setUpdateThrottleMs(e.target.value)}
          error={throttleInvalid}
          helperText={t("mapping.dialog.updateThrottleHelp")}
          slotProps={{ htmlInput: { min: 0, max: 60000, step: 100 } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={!editEntityId.trim() || saving || hasInvalidInput}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          {t("common.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
