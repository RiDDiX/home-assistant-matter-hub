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
import { endpointToJson } from "../utils/json/endpoint-to-json.js";

const ajv = new Ajv();

export function matterApi(
  bridgeService: BridgeService,
  haRegistry?: HomeAssistantRegistry,
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
      res.status(400).json(ajv.errors);
    } else {
      const bridge = await bridgeService.create(body);
      res.status(200).json(bridge.data);
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

  router.put("/bridges/:bridgeId", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const body = req.body as UpdateBridgeRequest;
    const isValid = ajv.validate(updateBridgeRequestSchema, body);
    if (!isValid) {
      res.status(400).json(ajv.errors);
    } else if (bridgeId !== body.id) {
      res.status(400).send("Path variable `bridgeId` does not match `body.id`");
    } else {
      const bridge = await bridgeService.update(body);
      if (!bridge) {
        res.status(404).send("Not Found");
      } else {
        res.status(200).json(bridge.data);
      }
    }
  });

  router.delete("/bridges/:bridgeId", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    await bridgeService.delete(bridgeId);
    res.status(204).send();
  });

  router.post("/bridges/:bridgeId/actions/factory-reset", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (bridge) {
      await bridge.factoryReset();
      await bridge.start();
      res.status(200).json(bridge.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.get("/bridges/:bridgeId/devices", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (bridge) {
      res.status(200).json(endpointToJson(bridge.server));
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.post("/bridges/:bridgeId/actions/restart", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const success = await bridgeService.restartBridge(bridgeId);
    if (success) {
      const bridge = bridgeService.get(bridgeId);
      res.status(200).json(bridge?.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.post("/bridges/:bridgeId/actions/start", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (bridge) {
      await bridge.start();
      res.status(200).json(bridge.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.post("/bridges/:bridgeId/actions/stop", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (bridge) {
      await bridge.stop();
      res.status(200).json(bridge.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.post("/bridges/:bridgeId/actions/refresh", async (req, res) => {
    const bridgeId = req.params.bridgeId;
    const bridge = bridgeService.bridges.find((b) => b.id === bridgeId);
    if (bridge) {
      await bridge.refreshDevices();
      res.status(200).json(bridge.data);
    } else {
      res.status(404).send("Not Found");
    }
  });

  router.get("/next-port", (_, res) => {
    const port = bridgeService.getNextAvailablePort();
    res.status(200).json({ port });
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

    const matchingEntities: Array<{
      entity_id: string;
      friendly_name?: string;
      domain: string;
    }> = [];

    for (const entity of entities) {
      const device = entity.device_id ? devices[entity.device_id] : undefined;

      const included =
        filter.include.length === 0 ||
        testMatchers(filter.include, device, entity);
      const excluded =
        filter.exclude.length > 0 &&
        testMatchers(filter.exclude, device, entity);

      if (included && !excluded) {
        const state = states[entity.entity_id];
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
