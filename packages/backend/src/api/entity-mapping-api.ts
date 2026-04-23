import type { EntityMappingRequest } from "@home-assistant-matter-hub/common";

import express from "express";
import rateLimit from "express-rate-limit";
import type { EntityMappingStorage } from "../services/storage/entity-mapping-storage.js";

/**
 * Provides the Express router for entity mapping API endpoints.
 * @param mappingStorage The storage instance for entity mappings.
 * Note: JWT secret is always 'dev_secret' for test compatibility, but JWT is not enforced here.
 * @returns An Express Router with entity mapping endpoints.
 */
export function entityMappingApi(
  mappingStorage: EntityMappingStorage,
  _jwtSecret: string = "dev_secret",
): express.Router {
  const router = express.Router();

  // Rate limiter: 100 requests per 15 minutes per IP
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });

  router.use(limiter);

  // Get all entity mappings for a bridge
  router.get("/:bridgeId", async (req, res) => {
    try {
      const { bridgeId } = req.params;
      const mappings = await mappingStorage.getMappingsForBridge(bridgeId);
      res.status(200).json({ bridgeId, mappings });
    } catch (_err) {
      res.status(500).json({ error: "Failed to fetch entity mappings" });
    }
  });

  // Get a single entity mapping by bridge and entity ID
  router.get("/:bridgeId/:entityId", async (req, res) => {
    try {
      const { bridgeId, entityId } = req.params;
      const mapping = await mappingStorage.getMapping(bridgeId, entityId);
      if (mapping) {
        res.status(200).json(mapping);
      } else {
        res.status(404).json({ error: "Mapping not found" });
      }
    } catch (_err) {
      res.status(500).json({ error: "Failed to fetch entity mapping" });
    }
  });

  // Create or update an entity mapping
  router.put("/:bridgeId/:entityId", async (req, res) => {
    try {
      const { bridgeId, entityId } = req.params;
      const body = req.body as Partial<EntityMappingRequest>;
      const request: EntityMappingRequest = {
        bridgeId,
        entityId,
        ...body,
      };
      const config = await mappingStorage.setMapping(request);
      res.status(200).json(config);
    } catch (_err) {
      res.status(400).json({ error: "Failed to save entity mapping" });
    }
  });

  // Delete an entity mapping by bridge and entity ID
  router.delete("/:bridgeId/:entityId", async (req, res) => {
    try {
      const { bridgeId, entityId } = req.params;
      await mappingStorage.deleteMapping(bridgeId, entityId);
      res.status(204).send();
    } catch (_err) {
      res.status(500).json({ error: "Failed to delete entity mapping" });
    }
  });

  // Delete all mappings for a bridge
  router.delete("/:bridgeId", async (req, res) => {
    try {
      const { bridgeId } = req.params;
      await mappingStorage.deleteBridgeMappings(bridgeId);
      res.status(204).send();
    } catch (_err) {
      res.status(500).json({ error: "Failed to delete bridge mappings" });
    }
  });

  // Public profile endpoint (no auth)
  router.get("/entity-mapping/public-profile", async (_req, res) => {
    // Implement as needed, or return 501 if not supported
    res.status(501).json({ error: "Not implemented" });
  });

  return router;
}
