import {
  type CreateBridgeRequest,
  createBridgeRequestSchema,
  type HomeAssistantFilter,
  type UpdateBridgeRequest,
  updateBridgeRequestSchema,
} from "@home-assistant-matter-hub/common";
import { Ajv } from "ajv";
import express from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { testMatchers } from "../services/bridges/matcher/matches-entity-filter.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";
import type { EntityIdentityStorage } from "../services/storage/entity-identity-storage.js";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";
import {
  buildPresentEntityIds,
  buildPresentIdentityKeys,
  computeOrphanCandidates,
  executeOrphanCleanup,
} from "../services/storage/orphan-cleanup.js";
import { endpointToJson } from "../utils/json/endpoint-to-json.js";

const ajv = new Ajv();

export function matterApi(
  bridgeService: BridgeService,
  haRegistry?: HomeAssistantRegistry,
  identityStorage?: EntityIdentityStorage,
  mappingStorage?: EntityMappingStorage,
): express.Router {
  const router = express.Router();
  router.get("/", (_, res) => {
    res.status(200).json({});
  });

  router.get("/bridges", async (_, res) => {
    res.status(200).json(bridgeService.bridges.map((b) => b.data));
  });

  router.post("/bridges", async (req, res) => {
    const body = req.body as CreateBridgeRequest;
    const isValid = ajv.validate(createBridgeRequestSchema, body);
    if (!isValid) {
      const details =
        ajv.errors
          ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
          .join("; ") ?? "Unknown";
      res.status(400).json({ error: `Validation failed: ${details}` });
    } else {
      try {
        const bridge = await bridgeService.create(body);
        res.status(200).json(bridge.data);
      } catch (e) {
        res.status(500).json({
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }
  });

  router.get("/bridges/:bridgeId", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.get(bridgeId);
    if (bridge) {
      res.status(200).json(bridge.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  // IMPORTANT: This route MUST be defined BEFORE /bridges/:bridgeId
  // because Express matches routes in definition order, and ":bridgeId"
  // would capture "priorities" as a parameter value.
  router.put("/bridges/priorities", async (req, res) => {
    const body = req.body as {
      updates: Array<{ id: string; priority: number }>;
    };
    if (!body.updates || !Array.isArray(body.updates)) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    try {
      await bridgeService.updatePriorities(body.updates);
      res.status(200).json({ success: true });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.put("/bridges/:bridgeId", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const body = req.body as UpdateBridgeRequest;
    const isValid = ajv.validate(updateBridgeRequestSchema, body);
    if (!isValid) {
      const details =
        ajv.errors
          ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
          .join("; ") ?? "Unknown";
      res.status(400).json({ error: `Validation failed: ${details}` });
    } else if (bridgeId !== body.id) {
      res.status(400).send("Path variable `bridgeId` does not match `body.id`");
    } else {
      try {
        const bridge = await bridgeService.update(body);
        if (!bridge) {
          res.status(404).send("Not Found");
        } else {
          res.status(200).json(bridge.data);
        }
      } catch (e) {
        res.status(500).json({
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }
  });

  router.delete("/bridges/:bridgeId", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    try {
      await bridgeService.delete(bridgeId);
      // Drop the bridge's frozen identities too, so a re-created bridge never
      // inherits stale anchors. Mirrors the entity-mapping whole-bridge delete
      // (#404).
      await identityStorage?.deleteBridgeIdentities(bridgeId);
      res.status(204).send();
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/factory-reset", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      // A factory reset erases the persisted endpoint numbers, so the frozen
      // identities no longer map to anything. Drop them BEFORE factoryReset:
      // it restarts the bridge and refreshes devices internally, and that
      // rebuild would otherwise re-seed against the wiped matter.js store (#404).
      await identityStorage?.deleteBridgeIdentities(bridgeId);
      await bridge.factoryReset();
      await bridge.start();
      res.status(200).json(bridge.data);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  // Manual orphan cleanup: entities removed from HA forever leave behind their
  // frozen identity record (and any mapping keyed to it). These two routes let
  // the user preview and prune those, gated by the 7-day tombstone.
  router.get("/bridges/:bridgeId/orphans", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    if (!haRegistry || !identityStorage) {
      res.status(503).json({ error: "Orphan cleanup is not available" });
      return;
    }
    const presentKeys = buildPresentIdentityKeys(haRegistry.entities);
    const presentEntityIds = buildPresentEntityIds(haRegistry.entities);
    const candidates = computeOrphanCandidates({
      bridgeId,
      identities: identityStorage.getBridgeIdentities(bridgeId),
      presentKeys,
      presentEntityIds,
      hasMapping: (entityId) =>
        mappingStorage?.getMapping(bridgeId, entityId) != null,
      mappings: mappingStorage?.getMappingsForBridge(bridgeId),
    });
    res.status(200).json({ candidates });
  });

  router.post(
    "/bridges/:bridgeId/actions/cleanup-orphans",
    async (req, res) => {
      const bridgeId = req.params.bridgeId;
      const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
      if (!bridge) {
        res.status(404).send("Not Found");
        return;
      }
      if (!haRegistry || !identityStorage || !mappingStorage) {
        res.status(503).json({ error: "Orphan cleanup is not available" });
        return;
      }
      const body = req.body as { identityKeys?: unknown };
      const requestedKeys = Array.isArray(body?.identityKeys)
        ? body.identityKeys.filter((k): k is string => typeof k === "string")
        : [];
      try {
        const results = await executeOrphanCleanup({
          bridgeId,
          requestedKeys,
          identities: identityStorage.getBridgeIdentities(bridgeId),
          presentKeys: buildPresentIdentityKeys(haRegistry.entities),
          presentEntityIds: buildPresentEntityIds(haRegistry.entities),
          getMapping: (b, e) => mappingStorage.getMapping(b, e),
          deleteMapping: (b, e) => mappingStorage.deleteMapping(b, e),
          deleteIdentity: (b, k) => identityStorage.deleteIdentity(b, k),
          mappings: mappingStorage.getMappingsForBridge(bridgeId),
        });
        res.status(200).json({ results });
      } catch (e) {
        res.status(500).json({
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    },
  );

  router.get("/bridges/:bridgeId/devices", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      res.status(200).json(endpointToJson(bridge.server));
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/restart", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    try {
      const success = await bridgeService.restartBridge(bridgeId);
      if (success) {
        const bridge = bridgeService.get(bridgeId);
        res.status(200).json(bridge?.data);
      } else {
        res.status(404).send("Not Found");
      }
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/start", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      await bridge.start();
      res.status(200).json(bridge.data);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/stop", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      await bridge.stop();
      res.status(200).json(bridge.data);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/refresh", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      await bridge.refreshDevices();
      res.status(200).json(bridge.data);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post("/bridges/:bridgeId/actions/force-sync", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (!bridge) {
      res.status(404).send("Not Found");
      return;
    }
    try {
      const syncedCount = await bridge.forceSync();
      res.status(200).json({ syncedCount, bridge: bridge.data });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  });

  router.post(
    "/bridges/:bridgeId/actions/open-commissioning-window",
    async (req, res) => {
      const bridgeId = req.params.bridgeId;
      const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
      if (!bridge) {
        res.status(404).send("Not Found");
        return;
      }
      try {
        await bridge.openCommissioningWindow();
        res.status(200).json({ success: true, bridge: bridge.data });
      } catch (e) {
        res.status(400).json({
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    },
  );

  router.post("/bridges/actions/start-all", async (_, res) => {
    try {
      await bridgeService.startAll();
      res
        .status(200)
        .json({ success: true, count: bridgeService.bridges.length });
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Unknown error" });
    }
  });

  router.post("/bridges/actions/stop-all", async (_, res) => {
    try {
      await bridgeService.stopAll();
      res
        .status(200)
        .json({ success: true, count: bridgeService.bridges.length });
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Unknown error" });
    }
  });

  router.post("/bridges/actions/restart-all", async (_, res) => {
    try {
      await bridgeService.restartAll();
      res
        .status(200)
        .json({ success: true, count: bridgeService.bridges.length });
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Unknown error" });
    }
  });

  router.post("/bridges/:bridgeId/clone", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const source = bridgeService.get(bridgeId);
    if (!source) {
      res.status(404).send("Not Found");
      return;
    }
    const data = source.data;
    const newPort = bridgeService.getNextAvailablePort();
    try {
      const clone = await bridgeService.create({
        name: `${data.name} (Copy)`,
        port: newPort,
        filter: data.filter,
        featureFlags: data.featureFlags,
        countryCode: data.countryCode,
        icon: data.icon,
        priority: data.priority,
      });
      res.status(200).json(clone.data);
    } catch (e) {
      res
        .status(500)
        .json({ error: e instanceof Error ? e.message : "Unknown error" });
    }
  });

  router.get("/next-port", (_, res) => {
    const port = bridgeService.getNextAvailablePort();
    res.status(200).json({ port });
  });

  router.get("/labels", async (_, res) => {
    if (!haRegistry) {
      res.status(503).json({ error: "Home Assistant registry not available" });
      return;
    }
    // Return labels with both label_id and display name to help users
    res.status(200).json(haRegistry.labels);
  });

  router.get("/areas", async (_, res) => {
    if (!haRegistry) {
      res.status(503).json({ error: "Home Assistant registry not available" });
      return;
    }
    const areas: Array<{ area_id: string; name: string }> = [];
    for (const [area_id, name] of haRegistry.areas) {
      areas.push({ area_id, name });
    }
    areas.sort((a, b) => a.name.localeCompare(b.name));
    res.status(200).json(areas);
  });

  router.get("/areas/summary", async (_, res) => {
    if (!haRegistry) {
      res.status(503).json({ error: "Home Assistant registry not available" });
      return;
    }

    const supportedDomains = new Set([
      "light",
      "switch",
      "sensor",
      "weather",
      "binary_sensor",
      "climate",
      "cover",
      "fan",
      "lock",
      "media_player",
      "vacuum",
      "valve",
      "humidifier",
      "water_heater",
      "select",
      "input_select",
      "input_boolean",
      "alarm_control_panel",
      "event",
      "automation",
      "script",
      "scene",
    ]);

    const entities = Object.values(haRegistry.entities);
    const devices = haRegistry.devices;
    const states = haRegistry.states;

    const areaSummary = new Map<
      string,
      { name: string; entityCount: number; domains: Record<string, number> }
    >();

    for (const [areaId, areaName] of haRegistry.areas) {
      areaSummary.set(areaId, { name: areaName, entityCount: 0, domains: {} });
    }

    for (const entity of entities) {
      if (entity.disabled_by != null) continue;

      const domain = entity.entity_id.split(".")[0];
      if (!supportedDomains.has(domain)) continue;

      const state = states[entity.entity_id];
      if (!state || state.state === "unavailable") continue;

      let areaId: string | undefined;
      const entityAreaId = entity.area_id;
      if (entityAreaId && haRegistry.areas.has(entityAreaId)) {
        areaId = entityAreaId;
      } else {
        const device = entity.device_id ? devices[entity.device_id] : undefined;
        const deviceAreaId = device?.area_id as string | undefined;
        if (deviceAreaId && haRegistry.areas.has(deviceAreaId)) {
          areaId = deviceAreaId;
        }
      }

      if (!areaId) continue;

      const summary = areaSummary.get(areaId);
      if (summary) {
        summary.entityCount++;
        summary.domains[domain] = (summary.domains[domain] || 0) + 1;
      }
    }

    const result = [...areaSummary.entries()]
      .map(([area_id, data]) => ({
        area_id,
        name: data.name,
        entityCount: data.entityCount,
        domains: data.domains,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.status(200).json(result);
  });

  router.get("/filter-values", async (_, res) => {
    if (!haRegistry) {
      res.status(503).json({ error: "Home Assistant registry not available" });
      return;
    }

    const entities = Object.values(haRegistry.entities);
    const devices = haRegistry.devices;
    const states = haRegistry.states;

    const domains = new Set<string>();
    const platforms = new Set<string>();
    const entityCategories = new Set<string>();
    const deviceClasses = new Set<string>();
    const deviceNames = new Set<string>();
    const productNames = new Set<string>();

    for (const entity of entities) {
      const domain = entity.entity_id.split(".")[0];
      if (domain) domains.add(domain);

      if (entity.platform) platforms.add(entity.platform);
      if (
        typeof entity.entity_category === "string" &&
        entity.entity_category
      ) {
        entityCategories.add(entity.entity_category);
      }

      const state = states[entity.entity_id];
      const deviceClass = state?.attributes?.device_class;
      if (typeof deviceClass === "string" && deviceClass) {
        deviceClasses.add(deviceClass);
      }

      const device = entity.device_id ? devices[entity.device_id] : undefined;
      if (device) {
        const name = device.name_by_user || device.name;
        if (name) deviceNames.add(name);
        if (device.model) productNames.add(device.model);
      }
    }

    const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));

    res.status(200).json({
      domains: sort(domains),
      platforms: sort(platforms),
      entityCategories: sort(entityCategories),
      deviceClasses: sort(deviceClasses),
      deviceNames: sort(deviceNames),
      productNames: sort(productNames),
    });
  });

  router.post("/filter-preview", async (req, res) => {
    if (!haRegistry) {
      res.status(503).json({ error: "Home Assistant registry not available" });
      return;
    }
    const filter = req.body as HomeAssistantFilter;
    if (!filter?.include || !filter?.exclude) {
      res.status(400).json({ error: "Invalid filter configuration" });
      return;
    }

    const entities = Object.values(haRegistry.entities);
    const devices = haRegistry.devices;
    const states = haRegistry.states;
    const labels = haRegistry.labels;

    const matchingEntities: Array<{
      entity_id: string;
      friendly_name?: string;
      domain: string;
    }> = [];

    for (const entity of entities) {
      const device = entity.device_id ? devices[entity.device_id] : undefined;
      const state = states[entity.entity_id];

      const included =
        filter.include.length === 0 ||
        testMatchers(
          filter.include,
          device,
          entity,
          filter.includeMode,
          state,
          labels,
        );
      const excluded =
        filter.exclude.length > 0 &&
        testMatchers(filter.exclude, device, entity, undefined, state, labels);

      if (included && !excluded) {
        matchingEntities.push({
          entity_id: entity.entity_id,
          friendly_name: state?.attributes?.friendly_name as string | undefined,
          domain: entity.entity_id.split(".")[0],
        });
      }
    }

    matchingEntities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

    res.status(200).json({
      total: matchingEntities.length,
      entities: matchingEntities.slice(0, 100),
      truncated: matchingEntities.length > 100,
    });
  });

  return router;
}
