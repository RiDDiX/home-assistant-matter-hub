import type { RuntimeService } from "@matter/main";
import type { AppEnvironment } from "../../core/ioc/app-environment.js";
import type { BackupService } from "../../services/backup/backup-service.js";
import type { BridgeService } from "../../services/bridges/bridge-service.js";

// the services are set once loaded, a crash before that only disposes the app
export interface ShutdownTargets {
  bridgeService?: Pick<BridgeService, "stopAll">;
  backupService?: Pick<BackupService, "createAutoBackup">;
  appEnvironment: Pick<AppEnvironment, "dispose">;
}

async function bounded(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one owner of app disposal and process exit. A runtime crash cancels
 * the app worker registered here, so the process ends instead of living on
 * without its web server.
 */
export function registerShutdown(
  runtime: RuntimeService,
  targets: ShutdownTargets,
) {
  let shuttingDown = false;
  let crashed = false;
  const shutdown = async (signal: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    const { bridgeService, backupService, appEnvironment } = targets;
    try {
      // Stop bridges first so each one closes its Matter sessions cleanly and
      // persists fabric/subscription state before the backup runs and the
      // container is torn down. Capped so a slow bridge can't block shutdown.
      if (bridgeService) await bounded(bridgeService.stopAll(), 10_000);
    } catch (e) {
      console.warn("Stopping bridges during shutdown failed:", e);
    }
    try {
      if (backupService) await bounded(backupService.createAutoBackup(), 5_000);
    } catch (e) {
      console.warn("Auto-backup during shutdown failed:", e);
    }
    try {
      // Dispose the whole IoC container so WebApi (releases the HTTP port),
      // HomeAssistantClient (closes the WS), and every storage service tear
      // down in reverse creation order before the process exits.
      await bounded(appEnvironment.dispose(), 15_000);
    } catch (e) {
      console.warn("Error during graceful shutdown:", e);
    }
    process.exit(code);
  };
  runtime.crashed.on(() => {
    crashed = true;
  });
  runtime.add({
    [Symbol.asyncDispose]: () =>
      crashed ? shutdown("runtime crash", 1) : shutdown("runtime shutdown"),
  });
  return shutdown;
}
