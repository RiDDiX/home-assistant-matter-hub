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
  onAuthChange?: () => void,
  allowedWithoutLogin?: (req: Request) => boolean,
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
      const { username, password } = req.body ?? {};
      if (
        typeof username !== "string" ||
        typeof password !== "string" ||
        !username.trim() ||
        !password.trim()
      ) {
        res.status(400).json({ error: "Username and password are required" });
        return;
      }
      if (username.includes(":")) {
        res.status(400).json({ error: "The username cannot contain a colon" });
        return;
      }
      // Basic auth compares the raw password, a trimmed one could never log in.
      if (password !== password.trim()) {
        res.status(400).json({
          error: "The password cannot start or end with a space",
        });
        return;
      }
      await settingsStorage.setAuth({
        username: username.trim(),
        password,
      });
      onAuthChange?.();
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
      req: Request,
      res: Response<SettingsAuthResponse | { error: string }>,
    ) => {
      if (envAuth) {
        res.status(409).json({
          error:
            "Auth is configured via environment variables and cannot be changed from the UI",
        });
        return;
      }
      // Without a login this client would get a 403 on its next request.
      if (allowedWithoutLogin && !allowedWithoutLogin(req)) {
        res.status(409).json({
          error:
            "Removing the login from this machine would lock you out. Remove it on the machine running HAMH, or set a new login instead.",
        });
        return;
      }
      await settingsStorage.setAuth(undefined);
      onAuthChange?.();
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
