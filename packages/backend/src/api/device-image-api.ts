import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import type { HomeAssistantRegistry } from "../services/home-assistant/home-assistant-registry.js";

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const Z2M_IMAGE_BASE = "https://www.zigbee2mqtt.io/images/devices";

function sanitizeEntityId(entityId: string): string {
  return entityId.replace(/[^a-z0-9._-]/gi, "_");
}

function findCustomImage(
  imagesDir: string,
  entityId: string,
): string | undefined {
  const sanitized = sanitizeEntityId(entityId);
  if (!fs.existsSync(imagesDir)) return undefined;
  const files = fs.readdirSync(imagesDir);
  const imageFile = files.find((f) => path.parse(f).name === sanitized);
  return imageFile ? path.join(imagesDir, imageFile) : undefined;
}

function resolveZ2mImageUrl(
  haRegistry: HomeAssistantRegistry,
  entityId: string,
): string | undefined {
  const entity = haRegistry.entities[entityId];
  if (!entity?.device_id) return undefined;
  const device = haRegistry.devices[entity.device_id];
  if (!device?.model) return undefined;
  return `${Z2M_IMAGE_BASE}/${encodeURIComponent(device.model)}.png`;
}

export function deviceImageApi(
  storageLocation: string,
  haRegistry: HomeAssistantRegistry,
): express.Router {
  const imagesDir = path.join(storageLocation, "device-images");

  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, imagesDir);
    },
    filename: (req, file, cb) => {
      const entityId = sanitizeEntityId(req.params.entityId as string);
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${entityId}${ext}`);
    },
  });

  const fileFilter = (
    _req: express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback,
  ) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
        ),
      );
    }
  };

  const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE },
  });

  const router = express.Router();

  // Batch resolve image availability for multiple entities.
  // Returns { [entityId]: { source: "custom" | "z2m" | "none", z2mUrl?: string } }
  router.post("/resolve", (req: express.Request, res: express.Response) => {
    const { entityIds } = req.body as { entityIds?: string[] };
    if (!entityIds || !Array.isArray(entityIds)) {
      res.status(400).json({ error: "entityIds array required" });
      return;
    }

    const result: Record<
      string,
      { source: "custom" | "z2m" | "none"; z2mUrl?: string }
    > = {};

    for (const entityId of entityIds) {
      const custom = findCustomImage(imagesDir, entityId);
      if (custom) {
        result[entityId] = { source: "custom" };
      } else {
        const z2mUrl = resolveZ2mImageUrl(haRegistry, entityId);
        if (z2mUrl) {
          result[entityId] = { source: "z2m", z2mUrl };
        } else {
          result[entityId] = { source: "none" };
        }
      }
    }

    res.json(result);
  });

  // Upload custom image for an entity
  router.post(
    "/:entityId",
    upload.single("image"),
    (req: express.Request, res: express.Response) => {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      // Delete any previous image with a different extension
      const sanitized = sanitizeEntityId(req.params.entityId as string);
      const files = fs.readdirSync(imagesDir);
      for (const f of files) {
        if (path.parse(f).name === sanitized && f !== req.file.filename) {
          fs.unlinkSync(path.join(imagesDir, f));
        }
      }
      res.json({ success: true });
    },
  );

  // Get image for an entity (custom file or z2m redirect)
  router.get("/:entityId", (req: express.Request, res: express.Response) => {
    const entityId = req.params.entityId as string;

    const customImage = findCustomImage(imagesDir, entityId);
    if (customImage) {
      res.sendFile(customImage, {
        headers: { "Content-Security-Policy": "sandbox" },
      });
      return;
    }

    const z2mUrl = resolveZ2mImageUrl(haRegistry, entityId);
    if (z2mUrl) {
      res.redirect(z2mUrl);
      return;
    }

    res.status(404).json({ error: "No image available" });
  });

  // Delete custom image for an entity
  router.delete("/:entityId", (req: express.Request, res: express.Response) => {
    const entityId = req.params.entityId as string;
    const customImage = findCustomImage(imagesDir, entityId);
    if (!customImage) {
      res.status(404).json({ error: "No custom image found" });
      return;
    }
    fs.unlinkSync(customImage);
    res.json({ success: true });
  });

  // Check if entity has any image
  router.head("/:entityId", (req: express.Request, res: express.Response) => {
    const entityId = req.params.entityId as string;

    const customImage = findCustomImage(imagesDir, entityId);
    if (customImage) {
      res.setHeader("X-Image-Source", "custom");
      res.status(200).end();
      return;
    }

    const z2mUrl = resolveZ2mImageUrl(haRegistry, entityId);
    if (z2mUrl) {
      res.setHeader("X-Image-Source", "z2m");
      res.status(200).end();
      return;
    }

    res.status(404).end();
  });

  return router;
}
