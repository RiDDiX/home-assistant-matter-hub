import type {
  EntityMappingConfig,
  HomeAssistantDomain,
  MappingProfile,
  MappingProfileEntry,
  MappingProfileImportMatch,
  MappingProfileImportPreview,
  MappingProfileImportResult,
} from "@home-assistant-matter-hub/common";
import express from "express";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";

function configToProfileEntry(
  config: EntityMappingConfig,
): MappingProfileEntry {
  const domain = config.entityId.split(".")[0] as HomeAssistantDomain;
  return {
    domain,
    entityIdPattern: config.entityId,
    matterDeviceType: config.matterDeviceType,
    customName: config.customName,
    disabled: config.disabled,
    filterLifeEntity: config.filterLifeEntity,
    cleaningModeEntity: config.cleaningModeEntity,
    temperatureEntity: config.temperatureEntity,
    humidityEntity: config.humidityEntity,
    pressureEntity: config.pressureEntity,
    batteryEntity: config.batteryEntity,
    disableBatteryMapping: config.disableBatteryMapping,
    roomEntities: config.roomEntities,
    disableLockPin: config.disableLockPin,
    lockWithoutPin: config.lockWithoutPin,
    lockUsercodeService: config.lockUsercodeService,
    lockUsercodeSlot: config.lockUsercodeSlot,
    lockPinMinLength: config.lockPinMinLength,
    lockPinMaxLength: config.lockPinMaxLength,
    powerEntity: config.powerEntity,
    energyEntity: config.energyEntity,
    meterSerialNumber: config.meterSerialNumber,
    pointOfDelivery: config.pointOfDelivery,
    voltageEntity: config.voltageEntity,
    currentEntity: config.currentEntity,
    batteryPowerEntity: config.batteryPowerEntity,
    batteryEnergyEntity: config.batteryEnergyEntity,
    chargingSwitchEntity: config.chargingSwitchEntity,
    currentLimitEntity: config.currentLimitEntity,
    suctionLevelEntity: config.suctionLevelEntity,
    mopIntensityEntity: config.mopIntensityEntity,
    customServiceAreas: config.customServiceAreas,
    customFanSpeedTags: config.customFanSpeedTags,
    fanWindPresets: config.fanWindPresets,
    fanRestoreSpeedOnPowerOn: config.fanRestoreSpeedOnPowerOn,
    valetudoIdentifier: config.valetudoIdentifier,
    coverSwapOpenClose: config.coverSwapOpenClose,
    coverOpenCloseAsPosition: config.coverOpenCloseAsPosition,
    coverSliderDebounceMs: config.coverSliderDebounceMs,
    fanSliderDebounceMs: config.fanSliderDebounceMs,
    disableClimateOnOff: config.disableClimateOnOff,
    disableClimateFanControl: config.disableClimateFanControl,
    climateKeepModeOnIdle: config.climateKeepModeOnIdle,
    climateForceTurnOn: config.climateForceTurnOn,
    climateBlockOff: config.climateBlockOff,
    climateExposeFan: config.climateExposeFan,
    climateAutoMode: config.climateAutoMode,
    disableMomentaryFlip: config.disableMomentaryFlip,
    vacuumAscendingRoomOrder: config.vacuumAscendingRoomOrder,
    vacuumRoomSwitches: config.vacuumRoomSwitches,
  };
}

// Exact entity id first, then the only entity of the entry's domain. Each
// target is used once, so two entries never write the same mapping.
export function matchProfileEntries(
  entries: MappingProfileEntry[],
  availableEntityIds: string[],
) {
  const available = [...new Set(availableEntityIds)];
  const taken = new Set<string>();
  const matches: MappingProfileImportMatch[] = [];
  const rest: MappingProfileEntry[] = [];
  for (const entry of entries) {
    const id = entry.entityIdPattern;
    if (id && available.includes(id) && !taken.has(id)) {
      taken.add(id);
      matches.push({ entry, matchedEntityId: id, matchType: "exact" });
    } else {
      rest.push(entry);
    }
  }
  const unmatchedEntries: MappingProfileEntry[] = [];
  for (const entry of rest) {
    const inDomain = available.filter(
      (id) => id.split(".")[0] === entry.domain,
    );
    if (inDomain.length === 1 && !taken.has(inDomain[0])) {
      taken.add(inDomain[0]);
      matches.push({
        entry,
        matchedEntityId: inDomain[0],
        matchType: "domain",
      });
    } else {
      unmatchedEntries.push(entry);
    }
  }
  return { matches, unmatchedEntries };
}

export function mappingProfileApi(
  mappingStorage: EntityMappingStorage,
): express.Router {
  const router = express.Router();

  router.get("/export/:bridgeId", (req, res) => {
    const { bridgeId } = req.params;
    const profileName = (req.query.name as string) || "Unnamed Profile";
    const entityIdsParam = req.query.entityIds as string | undefined;
    let mappings = mappingStorage.getMappingsForBridge(bridgeId);

    if (entityIdsParam) {
      const selectedIds = new Set(entityIdsParam.split(","));
      mappings = mappings.filter((m) => selectedIds.has(m.entityId));
    }

    if (mappings.length === 0) {
      res.status(404).json({ error: "No mappings found for this bridge" });
      return;
    }

    const entries = mappings.map(configToProfileEntry);
    const domains = [...new Set(entries.map((e) => e.domain))];

    const profile: MappingProfile = {
      version: 1,
      name: profileName,
      createdAt: new Date().toISOString(),
      domains,
      entryCount: entries.length,
      entries,
    };

    res.json(profile);
  });

  router.post("/import/preview/:bridgeId", (req, res) => {
    const { bridgeId } = req.params;
    const { profile, availableEntityIds } = req.body as {
      profile: MappingProfile;
      availableEntityIds: string[];
    };

    if (!profile?.entries || !Array.isArray(profile.entries)) {
      res.status(400).json({ error: "Invalid mapping profile format" });
      return;
    }

    if (!availableEntityIds || !Array.isArray(availableEntityIds)) {
      res.status(400).json({ error: "Missing availableEntityIds" });
      return;
    }

    const existingMappings = mappingStorage.getMappingsForBridge(bridgeId);
    const existingMap = new Map(existingMappings.map((m) => [m.entityId, m]));

    const { matches, unmatchedEntries } = matchProfileEntries(
      profile.entries,
      availableEntityIds,
    );

    const preview: MappingProfileImportPreview = {
      profileName: profile.name,
      totalEntries: profile.entries.length,
      matches: matches.map((m) => ({
        ...m,
        existingMapping: existingMap.get(m.matchedEntityId),
      })),
      unmatchedEntries,
    };

    res.json(preview);
  });

  router.post("/import/apply/:bridgeId", async (req, res) => {
    const { bridgeId } = req.params;
    const { profile, selectedEntityIds } = req.body as {
      profile: MappingProfile;
      selectedEntityIds: string[];
    };

    if (!Array.isArray(profile?.entries) || !Array.isArray(selectedEntityIds)) {
      res.status(400).json({ error: "Missing profile or selectedEntityIds" });
      return;
    }

    // The selection holds the preview targets, and matching against it
    // resolves every entry to the same target the preview showed.
    const targets = new Map(
      matchProfileEntries(profile.entries, selectedEntityIds).matches.map(
        (m) => [m.entry, m.matchedEntityId],
      ),
    );

    let applied = 0;
    let skipped = 0;
    const errors: Array<{ entityId: string; error: string }> = [];

    for (const entry of profile.entries) {
      const targetEntityId = targets.get(entry);

      if (!targetEntityId) {
        skipped++;
        continue;
      }

      try {
        await mappingStorage.setMapping({
          bridgeId,
          entityId: targetEntityId,
          matterDeviceType: entry.matterDeviceType,
          customName: entry.customName,
          disabled: entry.disabled,
          filterLifeEntity: entry.filterLifeEntity,
          cleaningModeEntity: entry.cleaningModeEntity,
          temperatureEntity: entry.temperatureEntity,
          humidityEntity: entry.humidityEntity,
          pressureEntity: entry.pressureEntity,
          batteryEntity: entry.batteryEntity,
          disableBatteryMapping: entry.disableBatteryMapping,
          roomEntities: entry.roomEntities,
          disableLockPin: entry.disableLockPin,
          lockWithoutPin: entry.lockWithoutPin,
          lockUsercodeService: entry.lockUsercodeService,
          lockUsercodeSlot: entry.lockUsercodeSlot,
          lockPinMinLength: entry.lockPinMinLength,
          lockPinMaxLength: entry.lockPinMaxLength,
          powerEntity: entry.powerEntity,
          energyEntity: entry.energyEntity,
          meterSerialNumber: entry.meterSerialNumber,
          pointOfDelivery: entry.pointOfDelivery,
          voltageEntity: entry.voltageEntity,
          currentEntity: entry.currentEntity,
          batteryPowerEntity: entry.batteryPowerEntity,
          batteryEnergyEntity: entry.batteryEnergyEntity,
          chargingSwitchEntity: entry.chargingSwitchEntity,
          currentLimitEntity: entry.currentLimitEntity,
          suctionLevelEntity: entry.suctionLevelEntity,
          mopIntensityEntity: entry.mopIntensityEntity,
          customServiceAreas: entry.customServiceAreas,
          customFanSpeedTags: entry.customFanSpeedTags,
          fanWindPresets: entry.fanWindPresets,
          fanRestoreSpeedOnPowerOn: entry.fanRestoreSpeedOnPowerOn,
          valetudoIdentifier: entry.valetudoIdentifier,
          coverSwapOpenClose: entry.coverSwapOpenClose,
          coverOpenCloseAsPosition: entry.coverOpenCloseAsPosition,
          coverSliderDebounceMs: entry.coverSliderDebounceMs,
          fanSliderDebounceMs: entry.fanSliderDebounceMs,
          disableClimateOnOff: entry.disableClimateOnOff,
          disableClimateFanControl: entry.disableClimateFanControl,
          climateKeepModeOnIdle: entry.climateKeepModeOnIdle,
          climateForceTurnOn: entry.climateForceTurnOn,
          climateBlockOff: entry.climateBlockOff,
          climateExposeFan: entry.climateExposeFan,
          climateAutoMode: entry.climateAutoMode,
          disableMomentaryFlip: entry.disableMomentaryFlip,
          vacuumAscendingRoomOrder: entry.vacuumAscendingRoomOrder,
          vacuumRoomSwitches: entry.vacuumRoomSwitches,
        });
        applied++;
      } catch (e) {
        errors.push({
          entityId: targetEntityId,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    const result: MappingProfileImportResult = {
      applied,
      skipped,
      errors,
    };

    res.json(result);
  });

  return router;
}
