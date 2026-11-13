import type {
  LockCredential,
  LockCredentialRequest,
  LockCredentialsResponse,
  SanitizedLockCredential,
} from "@home-assistant-matter-hub/common";
import { type Request, type Response, Router } from "express";
import { effectivePinCodeLengths } from "../matter/behaviors/lock-server.js";
import type { LockCredentialStorage } from "../services/storage/lock-credential-storage.js";

type PinLengthMapping = Parameters<typeof effectivePinCodeLengths>[0];

// The PIN is stored once per entity, so it has to fit the bounds every bridge
// mapping of that entity advertises (#418).
function pinLengthsOf(mappings: PinLengthMapping[]) {
  const all = (mappings.length > 0 ? mappings : [undefined]).map(
    effectivePinCodeLengths,
  );
  return {
    min: Math.max(...all.map((l) => l.min)),
    max: Math.min(...all.map((l) => l.max)),
  };
}

/**
 * Sanitize credential for API response - never expose PIN hash/salt
 */
function sanitizeCredential(
  credential: LockCredential,
): SanitizedLockCredential {
  return {
    entityId: credential.entityId,
    name: credential.name,
    enabled: credential.enabled,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    // Indicate PIN is set without exposing hash
    hasPinCode: !!credential.pinCodeHash,
  };
}

export function lockCredentialApi(
  lockCredentialStorage: LockCredentialStorage,
  mappingsOf: (entityId: string) => PinLengthMapping[] = () => [],
): Router {
  const router = Router();

  // Get all lock credentials
  router.get(
    "/",
    async (_req: Request, res: Response<LockCredentialsResponse>) => {
      const credentials = lockCredentialStorage.getAllCredentials();
      // Sanitize credentials - never expose PIN hash/salt
      const sanitizedCredentials = credentials.map(sanitizeCredential);
      res.json({ credentials: sanitizedCredentials });
    },
  );

  // Get a specific lock credential
  router.get(
    "/:entityId",
    async (
      req: Request<{ entityId: string }>,
      res: Response<ReturnType<typeof sanitizeCredential> | { error: string }>,
    ) => {
      const { entityId } = req.params;
      const decodedEntityId = decodeURIComponent(entityId);
      const credential = lockCredentialStorage.getCredential(decodedEntityId);

      if (!credential) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }

      res.json(sanitizeCredential(credential));
    },
  );

  // Create or update a lock credential
  router.put(
    "/:entityId",
    async (
      req: Request<{ entityId: string }, unknown, LockCredentialRequest>,
      res: Response<ReturnType<typeof sanitizeCredential> | { error: string }>,
    ) => {
      const { entityId } = req.params;
      const decodedEntityId = decodeURIComponent(entityId);
      const { pinCode, name, enabled } = req.body;

      if (typeof pinCode !== "string" || !/^\d+$/.test(pinCode)) {
        res.status(400).json({ error: "PIN code must contain only digits" });
        return;
      }

      const { min, max } = pinLengthsOf(mappingsOf(decodedEntityId));
      if (min > max) {
        res.status(400).json({
          error:
            "The PIN length settings of this lock's bridges do not overlap",
        });
        return;
      }
      if (pinCode.length < min || pinCode.length > max) {
        res
          .status(400)
          .json({ error: `PIN code must be between ${min} and ${max} digits` });
        return;
      }

      if (enabled !== undefined && typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }

      const credential = await lockCredentialStorage.setCredential({
        entityId: decodedEntityId,
        pinCode,
        name,
        enabled,
      });

      res.json(sanitizeCredential(credential));
    },
  );

  // Toggle enabled status without changing PIN
  router.patch(
    "/:entityId/enabled",
    async (
      req: Request<{ entityId: string }, unknown, { enabled: boolean }>,
      res: Response<ReturnType<typeof sanitizeCredential> | { error: string }>,
    ) => {
      const { entityId } = req.params;
      const decodedEntityId = decodeURIComponent(entityId);
      const enabled = req.body?.enabled;
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }

      const credential = await lockCredentialStorage.toggleEnabled(
        decodedEntityId,
        enabled,
      );

      if (!credential) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }

      res.json(sanitizeCredential(credential));
    },
  );

  // Delete a lock credential
  router.delete(
    "/:entityId",
    async (
      req: Request<{ entityId: string }>,
      res: Response<{ success: boolean }>,
    ) => {
      const { entityId } = req.params;
      const decodedEntityId = decodeURIComponent(entityId);
      await lockCredentialStorage.deleteCredential(decodedEntityId);
      res.json({ success: true });
    },
  );

  return router;
}
