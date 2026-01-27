import express from "express";
import type { HomeAssistantClient } from "../services/home-assistant/home-assistant-client.js";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";

export interface HomeAssistantEntityInfo {
  entity_id: string;
  friendly_name?: string;
  domain: string;
  device_id?: string;
  device_name?: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HomeAssistantDeviceInfo {
  id: string;
  name?: string;
  manufacturer?: string;
  model?: string;
  sw_version?: string;
  hw_version?: string;
  area_id?: string;
  entity_count: number;
}

export interface HomeAssistantStats {
  entities: {
    total: number;
    byDomain: Record<string, number>;
  };
  devices: {
    total: number;
  };
  connection: {
    connected: boolean;
    url: string;
  };
}

export function homeAssistantApi(
  haRegistry: HomeAssistantRegistry,
  haClient: HomeAssistantClient,
): express.Router {
  const router = express.Router();

  router.get("/stats", (_, res) => {
    const entities = Object.values(haRegistry.entities);
    const devices = Object.values(haRegistry.devices);

    const byDomain: Record<string, number> = {};
    for (const entity of entities) {
      const domain = entity.entity_id.split(".")[0];
      byDomain[domain] = (byDomain[domain] || 0) + 1;
    }

    const stats: HomeAssistantStats = {
      entities: {
        total: entities.length,
        byDomain,
      },
      devices: {
        total: devices.length,
      },
      connection: {
        connected: haClient.connection?.connected ?? false,
        url: "[redacted]",
      },
    };

    res.json(stats);
  });

  router.get("/entities", (req, res) => {
    const { domain, search, limit = "100", offset = "0" } = req.query;
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit as string, 10) || 100),
    );
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    let entities = Object.values(haRegistry.entities);
    const states = haRegistry.states;
    const devices = haRegistry.devices;

    if (domain && typeof domain === "string") {
      entities = entities.filter((e) => e.entity_id.startsWith(`${domain}.`));
    }

    if (search && typeof search === "string") {
      const searchLower = search.toLowerCase();
      entities = entities.filter((e) => {
        const state = states[e.entity_id];
        const friendlyName = state?.attributes?.friendly_name as
          | string
          | undefined;
        return (
          e.entity_id.toLowerCase().includes(searchLower) ||
          friendlyName?.toLowerCase().includes(searchLower)
        );
      });
    }

    const total = entities.length;
    entities = entities
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
      .slice(offsetNum, offsetNum + limitNum);

    const result: HomeAssistantEntityInfo[] = entities.map((entity) => {
      const state = states[entity.entity_id];
      const device = entity.device_id ? devices[entity.device_id] : undefined;
      return {
        entity_id: entity.entity_id,
        friendly_name: state?.attributes?.friendly_name as string | undefined,
        domain: entity.entity_id.split(".")[0],
        device_id: entity.device_id,
        device_name: device?.name,
        state: state?.state ?? "unknown",
        attributes: state?.attributes ?? {},
        last_changed: state?.last_changed,
        last_updated: state?.last_updated,
      };
    });

    res.json({
      total,
      limit: limitNum,
      offset: offsetNum,
      entities: result,
    });
  });

  router.get("/entities/:entityId", (req, res) => {
    const { entityId } = req.params;
    const entity = haRegistry.entities[entityId];
    const state = haRegistry.states[entityId];

    if (!entity && !state) {
      res.status(404).json({ error: "Entity not found" });
      return;
    }

    const device = entity?.device_id
      ? haRegistry.devices[entity.device_id]
      : undefined;

    const result: HomeAssistantEntityInfo = {
      entity_id: entityId,
      friendly_name: state?.attributes?.friendly_name as string | undefined,
      domain: entityId.split(".")[0],
      device_id: entity?.device_id,
      device_name: device?.name,
      state: state?.state ?? "unknown",
      attributes: state?.attributes ?? {},
      last_changed: state?.last_changed,
      last_updated: state?.last_updated,
    };

    res.json(result);
  });

  router.get("/devices", (req, res) => {
    const { search, limit = "100", offset = "0" } = req.query;
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit as string, 10) || 100),
    );
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    let devices = Object.values(haRegistry.devices);
    const entities = Object.values(haRegistry.entities);

    if (search && typeof search === "string") {
      const searchLower = search.toLowerCase();
      devices = devices.filter((d) => {
        return (
          d.name?.toLowerCase().includes(searchLower) ||
          d.manufacturer?.toLowerCase().includes(searchLower) ||
          d.model?.toLowerCase().includes(searchLower)
        );
      });
    }

    const total = devices.length;
    devices = devices
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
      .slice(offsetNum, offsetNum + limitNum);

    const result: HomeAssistantDeviceInfo[] = devices.map((device) => {
      const entityCount = entities.filter(
        (e) => e.device_id === device.id,
      ).length;
      return {
        id: device.id,
        name: device.name,
        manufacturer: device.manufacturer,
        model: device.model,
        sw_version: device.sw_version,
        hw_version: device.hw_version,
        area_id: device.area_id as string | undefined,
        entity_count: entityCount,
      };
    });

    res.json({
      total,
      limit: limitNum,
      offset: offsetNum,
      devices: result,
    });
  });

  router.get("/devices/:deviceId", (req, res) => {
    const { deviceId } = req.params;
    const device = haRegistry.devices[deviceId];

    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    const entities = Object.values(haRegistry.entities).filter(
      (e) => e.device_id === deviceId,
    );
    const states = haRegistry.states;

    const entityInfos: HomeAssistantEntityInfo[] = entities.map((entity) => {
      const state = states[entity.entity_id];
      return {
        entity_id: entity.entity_id,
        friendly_name: state?.attributes?.friendly_name as string | undefined,
        domain: entity.entity_id.split(".")[0],
        device_id: entity.device_id,
        device_name: device.name,
        state: state?.state ?? "unknown",
        attributes: state?.attributes ?? {},
        last_changed: state?.last_changed,
        last_updated: state?.last_updated,
      };
    });

    const result: HomeAssistantDeviceInfo & {
      entities: HomeAssistantEntityInfo[];
    } = {
      id: device.id,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      sw_version: device.sw_version,
      hw_version: device.hw_version,
      area_id: device.area_id as string | undefined,
      entity_count: entities.length,
      entities: entityInfos,
    };

    res.json(result);
  });

  router.get("/domains", (_, res) => {
    const entities = Object.values(haRegistry.entities);
    const domainCounts: Record<string, number> = {};

    for (const entity of entities) {
      const domain = entity.entity_id.split(".")[0];
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    }

    const domains = Object.entries(domainCounts)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);

    res.json({ domains });
  });

  router.post("/refresh", async (_, res) => {
    try {
      await (haRegistry as unknown as { reload(): Promise<void> }).reload();
      res.json({ success: true, message: "Registry refreshed" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
