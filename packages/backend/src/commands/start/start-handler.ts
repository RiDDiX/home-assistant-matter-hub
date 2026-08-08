import { Logger } from "@matter/general";
import * as ws from "ws";
import type { ArgumentsCamelCase } from "yargs";
import { WebApi } from "../../api/web-api.js";
import { configureDefaultEnvironment } from "../../core/app/configure-default-environment.js";
import { Options } from "../../core/app/options.js";
import { AppEnvironment } from "../../core/ioc/app-environment.js";
import { patchLevelControlTlv } from "../../matter/patches/patch-level-control-tlv.js";
import { BackupService } from "../../services/backup/backup-service.js";
import { BridgeService } from "../../services/bridges/bridge-service.js";
import { EntityIsolationService } from "../../services/bridges/entity-isolation-service.js";
import { HomeAssistantClient } from "../../services/home-assistant/home-assistant-client.js";
import { HomeAssistantRegistry } from "../../services/home-assistant/home-assistant-registry.js";
import { AppSettingsStorage } from "../../services/storage/app-settings-storage.js";
import { logStartupMemoryGuard } from "../../utils/log-memory.js";
import {
  isIsolatableError,
  shouldSuppressError,
} from "./start-error-matchers.js";
import type { StartOptions } from "./start-options.js";

// Register early error handlers to catch errors before Matter.js initializes
process.on("uncaughtException", (error) => {
  if (shouldSuppressError(error)) {
    return; // Suppress this specific error
  }
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (shouldSuppressError(reason)) {
    return; // Suppress this specific error
  }
  console.error("Unhandled rejection (process continuing):", reason);
});

// Re-register error handlers after Matter.js initialization to override its handlers
// Matter.js registers its own handlers that call process.exit(1), so we need to be last
function registerFinalErrorHandlers() {
  // Drop every existing listener and re-attach ours so the suppression
  // logic sits at the end of the chain, matter.js hooks its own handlers
  // that would otherwise call process.exit(1) before we get a look in.
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");

  process.on("uncaughtException", (error) => {
    if (shouldSuppressError(error)) {
      // Try to isolate the problematic entity instead of just suppressing
      if (isIsolatableError(error)) {
        EntityIsolationService.isolateFromError(error).catch(() => {
          // Isolation failed, but error is still suppressed
        });
      }
      console.warn("Suppressed Matter.js internal error:", error);
      return;
    }
    console.error("Uncaught exception:", error);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (shouldSuppressError(reason)) {
      // Try to isolate the problematic entity instead of just suppressing
      if (isIsolatableError(reason)) {
        EntityIsolationService.isolateFromError(reason).catch(() => {
          // Isolation failed, but error is still suppressed
        });
      }
      console.warn("Suppressed Matter.js internal error:", reason);
      return;
    }
    // Log but don't crash, unhandled rejections are non-fatal async failures.
    // Plugins may emit fire-and-forget promises that escape SafePluginRunner.
    console.error("Unhandled rejection (process continuing):", reason);
  });
}

export async function startHandler(
  startOptions: ArgumentsCamelCase<StartOptions>,
  webUiDist?: string,
): Promise<void> {
  Object.assign(globalThis, { WebSocket: ws.WebSocket });

  // Patch Matter.js TLV schemas before any clusters are instantiated
  patchLevelControlTlv();

  const options = new Options({ ...startOptions, webUiDist });
  const rootEnv = configureDefaultEnvironment(options);

  // Log system memory early so low-resource devices get a warning before
  // heavy initialization (Matter.js, HA registry, bridges) begins.
  logStartupMemoryGuard(Logger.get("Startup"));

  const appEnvironment = await AppEnvironment.create(rootEnv, options);

  // Register final error handlers AFTER Matter.js initialization
  // This overrides Matter.js's crash handlers that would otherwise call process.exit(1)
  registerFinalErrorHandlers();

  const bridgeService$ = appEnvironment.load(BridgeService);
  const webApi$ = appEnvironment.load(WebApi);
  const registry$ = appEnvironment.load(HomeAssistantRegistry);
  const backupService$ = appEnvironment.load(BackupService);

  // Wire up WebSocket broadcasts for bridge status changes so the frontend
  // sees each Stopped → Starting → Running transition as it happens during
  // startup rather than after the whole set finishes.
  const [bridgeService, webApi, backupService] = await Promise.all([
    bridgeService$,
    webApi$,
    backupService$,
  ]);
  bridgeService.onBridgeChanged = (bridgeId) => {
    webApi.websocket.broadcastBridgeUpdate(bridgeId);
  };

  const [haClient, settingsStorage] = await Promise.all([
    appEnvironment.load(HomeAssistantClient),
    appEnvironment.load(AppSettingsStorage),
  ]);
  // Use the persisted recovery settings instead of the built-in defaults.
  bridgeService.applyRecoverySettings(settingsStorage.recoverySettings);
  // When Home Assistant reconnects, try to recover failed bridges right away
  // instead of waiting for the next interval. Only failed bridges are touched.
  haClient.connection.addEventListener("ready", () => {
    bridgeService.recoverFailedBridgesNow();
  });

  // Register graceful shutdown handlers.
  // When the process receives SIGTERM (Docker stop) or SIGINT (Ctrl+C),
  // stop all bridges cleanly so matter.js persists fabric/subscription state.
  let shuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      // Stop bridges first so each one closes its Matter sessions cleanly and
      // persists fabric/subscription state before the backup runs and the
      // container is torn down. Capped so a slow bridge can't block shutdown.
      await Promise.race([
        bridgeService.stopAll(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (e) {
      console.warn("Stopping bridges during shutdown failed:", e);
    }
    try {
      await Promise.race([
        backupService.createAutoBackup(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch (e) {
      console.warn("Auto-backup during shutdown failed:", e);
    }
    try {
      // Dispose the whole IoC container so WebApi (releases the HTTP port),
      // HomeAssistantClient (closes the WS), and every storage service tear
      // down in reverse creation order before the process exits.
      await Promise.race([
        appEnvironment.dispose(),
        new Promise((resolve) => setTimeout(resolve, 15_000)),
      ]);
    } catch (e) {
      console.warn("Error during graceful shutdown:", e);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  const initBridges = bridgeService.startAll();
  const initApi = webApi.start();

  const enableAutoRefresh = initBridges
    .then(() => registry$)
    .then((r) => r.enableAutoRefresh(() => bridgeService.refreshAll()));

  await Promise.all([initBridges, initApi, enableAutoRefresh]);
}
