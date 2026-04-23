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
import rateLimit from "express-rate-limit";
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
    roomEntities: config.roomEntities,
    disableLockPin: config.disableLockPin,
    powerEntity: config.powerEntity,
    energyEntity: config.energyEntity,
    suctionLevelEntity: config.suctionLevelEntity,
    mopIntensityEntity: config.mopIntensityEntity,
    customServiceAreas: config.customServiceAreas,
    customFanSpeedTags: config.customFanSpeedTags,
    valetudoIdentifier: config.valetudoIdentifier,
    coverSwapOpenClose: config.coverSwapOpenClose,
  };
}

export function mappingProfileApi(
  mappingStorage: EntityMappingStorage,
  _jwtSecret: string = "dev_secret",
): express.Router {
  const router = express.Router();
  // Rate limiting middleware (per IP)
  router.use(
    rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 30, // 30 requests per minute per IP
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

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

    const matches: MappingProfileImportMatch[] = [];
    const unmatchedEntries: MappingProfileEntry[] = [];

    for (const entry of profile.entries) {
      let matched = false;

      if (
        entry.entityIdPattern &&
        availableEntityIds.includes(entry.entityIdPattern)
      ) {
        matches.push({
          entry,
          matchedEntityId: entry.entityIdPattern,
          matchType: "exact",
          existingMapping: existingMap.get(entry.entityIdPattern),
        });
        matched = true;
      }

      if (!matched) {
        const domainEntities = availableEntityIds.filter(
          (id: string) => id.split(".")[0] === entry.domain,
        );
        if (domainEntities.length === 1) {
          matches.push({
            entry,
            matchedEntityId: domainEntities[0],
            matchType: "domain",
            existingMapping: existingMap.get(domainEntities[0]),
          });
          matched = true;
        }
      }

      if (!matched) {
        unmatchedEntries.push(entry);
      }
    }

    const preview: MappingProfileImportPreview = {
      profileName: profile.name,
      totalEntries: profile.entries.length,
      matches,
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

    if (!profile?.entries || !selectedEntityIds) {
      res.status(400).json({ error: "Missing profile or selectedEntityIds" });
      return;
    }

    const selectedSet = new Set(selectedEntityIds);

    let applied = 0;
    let skipped = 0;
    const errors: Array<{ entityId: string; error: string }> = [];

    for (const entry of profile.entries) {
      const targetEntityId = entry.entityIdPattern;

      if (!targetEntityId || !selectedSet.has(targetEntityId)) {
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
          roomEntities: entry.roomEntities,
          disableLockPin: entry.disableLockPin,
          powerEntity: entry.powerEntity,
          energyEntity: entry.energyEntity,
          suctionLevelEntity: entry.suctionLevelEntity,
          mopIntensityEntity: entry.mopIntensityEntity,
          customServiceAreas: entry.customServiceAreas,
          customFanSpeedTags: entry.customFanSpeedTags,
          valetudoIdentifier: entry.valetudoIdentifier,
          coverSwapOpenClose: entry.coverSwapOpenClose,
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
