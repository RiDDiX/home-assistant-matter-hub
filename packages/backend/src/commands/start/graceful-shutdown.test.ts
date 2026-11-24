import { Environment } from "@matter/general";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShutdown, type ShutdownTargets } from "./graceful-shutdown.js";

// A runtime crash disposed the app but left the process running without its
// web server, and a crash during a shutdown must not cut the backup short.

function setup(name: string) {
  const order: string[] = [];
  let finishBackup = () => {};
  const backupDone = new Promise<void>((r) => {
    finishBackup = r;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    order.push(`exit ${code}`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const runtime = new Environment(name).runtime;
  const targets: ShutdownTargets = {
    appEnvironment: {
      dispose: async () => {
        order.push("dispose");
      },
    },
  };
  const shutdown = registerShutdown(runtime, targets);
  // what the start handler sets once the services are loaded
  const loaded = () =>
    Object.assign(targets, {
      bridgeService: {
        stopAll: async () => {
          order.push("stopAll");
        },
      },
      backupService: {
        createAutoBackup: async () => {
          order.push("backup");
          await backupDone;
          return null;
        },
      },
    });
  return { order, exit, runtime, shutdown, finishBackup, loaded };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("graceful shutdown", () => {
  it("disposes and exits with 1 on a crash before the services load", async () => {
    const { order, exit, runtime } = setup("early");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    runtime.add(Promise.reject(new Error("worker failed")));
    await until(() => exit.mock.calls.length > 0);

    expect(order).toEqual(["dispose", "exit 1"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("exits with 1 after disposal when the runtime crashes", async () => {
    const { order, exit, runtime, finishBackup, loaded } = setup("crash");
    loaded();
    finishBackup();

    runtime.add(Promise.reject(new Error("worker failed")));
    await until(() => exit.mock.calls.length > 0);

    expect(order).toEqual(["stopAll", "backup", "dispose", "exit 1"]);
  });

  it("lets a running shutdown finish when the runtime crashes", async () => {
    const { order, exit, runtime, shutdown, finishBackup, loaded } =
      setup("during");
    loaded();

    const done = shutdown("SIGTERM");
    await until(() => order.includes("backup"));
    runtime.add(Promise.reject(new Error("worker failed")));
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
    finishBackup();
    await done;
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual(["stopAll", "backup", "dispose", "exit 0"]);
  });

  it("exits with 0 on a signal", async () => {
    const { order, shutdown, finishBackup, loaded } = setup("plain");
    loaded();
    finishBackup();

    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(order).toEqual(["stopAll", "backup", "dispose", "exit 0"]);
  });
});
