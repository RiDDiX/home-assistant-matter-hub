import type { EntityMappingRequest } from "@home-assistant-matter-hub/common";
import express from "express";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";

export function entityMappingApi(
  mappingStorage: EntityMappingStorage,
): express.Router {
  const router = express.Router();

  router.get("/:bridgeId", (req, res) => {
    const { bridgeId } = req.params;
    const mappings = mappingStorage.getMappingsForBridge(bridgeId);
    res.status(200).json({ bridgeId, mappings });
  });

  router.get("/:bridgeId/:entityId", (req, res) => {
    const { bridgeId, entityId } = req.params;
    const mapping = mappingStorage.getMapping(bridgeId, entityId);
    if (mapping) {
      res.status(200).json(mapping);
    } else {
      res.status(404).json({ error: "Mapping not found" });
    }
  });

  router.put("/:bridgeId/:entityId", async (req, res) => {
    const { bridgeId, entityId } = req.params;
    const body = req.body as Partial<EntityMappingRequest>;

    const request: EntityMappingRequest = {
      bridgeId,
      entityId,
      matterDeviceType: body.matterDeviceType,
      customName: body.customName,
      customProductName: body.customProductName,
      customVendorName: body.customVendorName,
      customSerialNumber: body.customSerialNumber,
      customVendorId: body.customVendorId,
      disabled: body.disabled,
      filterLifeEntity: body.filterLifeEntity,
      cleaningModeEntity: body.cleaningModeEntity,
      temperatureEntity: body.temperatureEntity,
      humidityEntity: body.humidityEntity,
      pressureEntity: body.pressureEntity,
      batteryEntity: body.batteryEntity,
      chargingStateEntity: body.chargingStateEntity,
      roomEntities: body.roomEntities,
      disableLockPin: body.disableLockPin,
      lockUsercodeService: body.lockUsercodeService,
      lockUsercodeSlot: body.lockUsercodeSlot,
      lockPinMinLength: body.lockPinMinLength,
      lockPinMaxLength: body.lockPinMaxLength,
      powerEntity: body.powerEntity,
      energyEntity: body.energyEntity,
      suctionLevelEntity: body.suctionLevelEntity,
      mopIntensityEntity: body.mopIntensityEntity,
      customServiceAreas: body.customServiceAreas,
      customFanSpeedTags: body.customFanSpeedTags,
      fanWindPresets: body.fanWindPresets,
      fanRestoreSpeedOnPowerOn: body.fanRestoreSpeedOnPowerOn,
      currentRoomEntity: body.currentRoomEntity,
      cleanedAreaEntity: body.cleanedAreaEntity,
      disableCustomAreaRoomModes: body.disableCustomAreaRoomModes,
      valetudoIdentifier: body.valetudoIdentifier,
      coverSwapOpenClose: body.coverSwapOpenClose,
      coverExposeAsDimmableLight: body.coverExposeAsDimmableLight,
      selectExposeAsSwitch: body.selectExposeAsSwitch,
      selectSwitchOnOption: body.selectSwitchOnOption,
      selectSwitchOffOption: body.selectSwitchOffOption,
      coverSliderDebounceMs: body.coverSliderDebounceMs,
      updateThrottleMs: body.updateThrottleMs,
      disableClimateOnOff: body.disableClimateOnOff,
      disableClimateFanControl: body.disableClimateFanControl,
      climateKeepModeOnIdle: body.climateKeepModeOnIdle,
      climateExposeFan: body.climateExposeFan,
      climateAutoMode: body.climateAutoMode,
      composedEntities: body.composedEntities,
    };

    const config = await mappingStorage.setMapping(request);
    res.status(200).json(config);
  });

  router.delete("/:bridgeId/:entityId", async (req, res) => {
    const { bridgeId, entityId } = req.params;
    await mappingStorage.deleteMapping(bridgeId, entityId);
    res.status(204).send();
  });

  router.delete("/:bridgeId", async (req, res) => {
    const { bridgeId } = req.params;
    await mappingStorage.deleteBridgeMappings(bridgeId);
    res.status(204).send();
  });

  return router;
}
