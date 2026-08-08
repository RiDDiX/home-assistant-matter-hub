import { type Request, type Response, Router } from "express";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import {
  type AppSettingsStorage,
  MAX_RECOVERY_INTERVAL_MS,
  MIN_RECOVERY_INTERVAL_MS,
  type RecoverySettings,
} from "../services/storage/app-settings-storage.js";

export interface SettingsAuthResponse {
  enabled: boolean;
  username?: string;
  source: "environment" | "storage" | "none";
}

export function settingsApi(
  settingsStorage: AppSettingsStorage,
  bridgeService: BridgeService,
  envAuth?: { username: string; password: string },
): Router {
  const router = Router();

  router.get("/auth", (_req: Request, res: Response<SettingsAuthResponse>) => {
    if (envAuth) {
      res.json({
        enabled: true,
        username: envAuth.username,
        source: "environment",
      });
    } else if (settingsStorage.auth) {
      res.json({
        enabled: true,
        username: settingsStorage.auth.username,
        source: "storage",
      });
    } else {
      res.json({ enabled: false, source: "none" });
    }
  });

  router.put(
    "/auth",
    async (
      req: Request<unknown, unknown, { username: string; password: string }>,
      res: Response<SettingsAuthResponse | { error: string }>,
    ) => {
      if (envAuth) {
        res.status(409).json({
          error:
            "Auth is configured via environment variables and cannot be changed from the UI",
        });
        return;
      }
      const { username, password } = req.body;
      if (!username?.trim() || !password?.trim()) {
        res.status(400).json({ error: "Username and password are required" });
        return;
      }
      await settingsStorage.setAuth({
        username: username.trim(),
        password: password.trim(),
      });
      res.json({
        enabled: true,
        username: username.trim(),
        source: "storage",
      });
    },
  );

  router.delete(
    "/auth",
    async (
      _req: Request,
      res: Response<SettingsAuthResponse | { error: string }>,
    ) => {
      if (envAuth) {
        res.status(409).json({
          error:
            "Auth is configured via environment variables and cannot be changed from the UI",
        });
        return;
      }
      await settingsStorage.setAuth(undefined);
      res.json({ enabled: false, source: "none" });
    },
  );

  router.get("/recovery", (_req: Request, res: Response<RecoverySettings>) => {
    res.json(settingsStorage.recoverySettings);
  });

  router.put(
    "/recovery",
    async (
      req: Request<unknown, unknown, Partial<RecoverySettings>>,
      res: Response<RecoverySettings | { error: string }>,
    ) => {
      const next = { ...settingsStorage.recoverySettings };
      const { autoRecoveryEnabled, recoveryIntervalMs } = req.body;
      if (typeof autoRecoveryEnabled === "boolean") {
        next.autoRecoveryEnabled = autoRecoveryEnabled;
      }
      if (typeof recoveryIntervalMs === "number") {
        if (
          recoveryIntervalMs < MIN_RECOVERY_INTERVAL_MS ||
          recoveryIntervalMs > MAX_RECOVERY_INTERVAL_MS
        ) {
          res.status(400).json({
            error: `recoveryIntervalMs must be between ${MIN_RECOVERY_INTERVAL_MS} and ${MAX_RECOVERY_INTERVAL_MS}`,
          });
          return;
        }
        next.recoveryIntervalMs = recoveryIntervalMs;
      }
      await settingsStorage.setRecoverySettings(next);
      bridgeService.applyRecoverySettings(next);
      res.json(next);
    },
  );

  return router;
}
