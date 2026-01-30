import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";

const ALLOWED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function bridgeIconApi(storageLocation: string): express.Router {
  const iconsDir = path.join(storageLocation, "bridge-icons");

  // Ensure icons directory exists
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      cb(null, iconsDir);
    },
    filename: (req, file, cb) => {
      const bridgeId = req.params.bridgeId;
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${bridgeId}${ext}`);
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

  // Upload icon for a bridge
  router.post(
    "/:bridgeId",
    upload.single("icon"),
    (req: express.Request, res: express.Response) => {
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      const iconUrl = `api/bridge-icons/${req.params.bridgeId}`;
      res.json({ success: true, iconUrl });
    },
  );

  // Get icon for a bridge
  router.get("/:bridgeId", (req: express.Request, res: express.Response) => {
    const bridgeId = req.params.bridgeId;

    // Find the icon file (could have different extensions)
    const files = fs.readdirSync(iconsDir);
    const iconFile = files.find((f) => f.startsWith(`${bridgeId}.`));

    if (!iconFile) {
      res.status(404).json({ error: "Icon not found" });
      return;
    }

    const filePath = path.join(iconsDir, iconFile);
    res.sendFile(filePath);
  });

  // Delete icon for a bridge
  router.delete("/:bridgeId", (req: express.Request, res: express.Response) => {
    const bridgeId = req.params.bridgeId;

    // Find and delete the icon file
    const files = fs.readdirSync(iconsDir);
    const iconFile = files.find((f) => f.startsWith(`${bridgeId}.`));

    if (!iconFile) {
      res.status(404).json({ error: "Icon not found" });
      return;
    }

    const filePath = path.join(iconsDir, iconFile);
    fs.unlinkSync(filePath);
    res.json({ success: true });
  });

  // Check if bridge has custom icon
  router.head("/:bridgeId", (req: express.Request, res: express.Response) => {
    const bridgeId = req.params.bridgeId;
    const files = fs.readdirSync(iconsDir);
    const iconFile = files.find((f) => f.startsWith(`${bridgeId}.`));

    if (iconFile) {
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  });

  return router;
}
