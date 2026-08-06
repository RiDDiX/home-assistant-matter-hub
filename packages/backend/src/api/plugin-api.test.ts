import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeService } from "../services/bridges/bridge-service.js";
import { pluginApi } from "./plugin-api.js";

// A server mode bridge carries none of the plugin surface: no pluginInfo, no
// enablePlugin and friends. The plugins API must skip it in the listing and
// answer the per-bridge routes cleanly instead of 500ing the page (#430).

// The real installer shells out to `npm install`, which is exactly the #432
// bug. Stub it so every install here stays offline and each attempt is visible.
const { installCalls } = vi.hoisted(() => ({ installCalls: [] as string[] }));

vi.mock("../plugins/plugin-installer.js", () => ({
  PluginInstaller: class {
    async install(packageName: string) {
      installCalls.push(packageName);
      return { success: true, packageName, version: "1.0.0" };
    }
    // The tgz and local paths read the name out of the package itself, so the
    // stub echoes a name the caller plants via the payload or path.
    async installFromTgz(buf: Buffer) {
      const packageName = buf.toString();
      installCalls.push(packageName);
      return { success: true, packageName, version: "1.0.0" };
    }
    installFromLocal(localPath: string) {
      const packageName = localPath.split("/").pop() ?? localPath;
      installCalls.push(packageName);
      return { success: true, packageName, version: "1.0.0" };
    }
    listInstalled() {
      return [];
    }
    getPluginPath(packageName: string) {
      return `/nowhere/${packageName}`;
    }
  },
}));

const dir = mkdtempSync(join(tmpdir(), "hamh-plugin-api-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pluginBridge = {
  id: "b1",
  data: { name: "Bridge One" },
  pluginInfo: {
    metadata: [
      {
        name: "camera",
        version: "1.0.0",
        source: "builtin",
        enabled: true,
        config: {},
      },
      {
        name: "hamh-plugin-thing",
        version: "2.0.0",
        source: "/data/plugin-packages/hamh-plugin-thing",
        enabled: true,
        config: {},
      },
    ],
    circuitBreakers: {},
    devices: [],
  },
};
const serverModeBridge = {
  id: "sm1",
  data: { name: "Vacuum" },
  // no pluginInfo, no plugin methods
};

function service(bridges: object[] = [pluginBridge, serverModeBridge]) {
  return {
    bridges,
    get: (id: string) =>
      bridges.find((b) => (b as { id: string }).id === id) as never,
  } as unknown as BridgeService;
}

async function withRouter(
  fn: (baseUrl: string) => Promise<void>,
  bridges?: object[],
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use("/plugins", pluginApi(service(bridges), dir));
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("plugin api with a server mode bridge present (#430)", () => {
  it("lists plugins without 500ing, skipping the server mode bridge", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ bridgeId: string }>;
      const ids = body.map((b) => b.bridgeId);
      expect(ids).toContain("b1");
      expect(ids).not.toContain("sm1");
    });
  });

  it("answers per-bridge plugin routes with 400 for a server mode bridge", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/sm1/camera/enable`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("does not support plugins");
    });
  });

  it("still 404s for an unknown bridge id", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/nope/camera/enable`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});

describe("secret config values in the listing", () => {
  const bridgeWithToken = {
    id: "b1",
    data: { name: "Bridge One" },
    getPluginConfigSchema: (name: string) =>
      name === "camera"
        ? {
            title: "Camera",
            properties: {
              haToken: { type: "string", title: "Token", secret: true },
              cameras: { type: "string", title: "Cameras" },
            },
          }
        : undefined,
    pluginInfo: {
      metadata: [
        {
          name: "camera",
          version: "1.0.0",
          source: "builtin",
          enabled: true,
          config: { cameras: "camera.x", haToken: "very-secret-token" },
        },
      ],
      circuitBreakers: {},
      devices: [],
    },
  };

  it("never serves a stored secret to the browser", async () => {
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/plugins`);
        const body = (await res.json()) as Array<{
          plugins: Array<{ config: Record<string, unknown> }>;
        }>;
        expect(body[0].plugins[0].config).toEqual({
          cameras: "camera.x",
          haToken: "__unchanged__",
        });
      },
      [bridgeWithToken],
    );
  });

  it("leaves an unset secret alone so the dialog shows it empty", async () => {
    const noToken = {
      ...bridgeWithToken,
      pluginInfo: {
        ...bridgeWithToken.pluginInfo,
        metadata: [
          {
            ...bridgeWithToken.pluginInfo.metadata[0],
            config: { cameras: "camera.x" },
          },
        ],
      },
    };
    await withRouter(
      async (base) => {
        const res = await fetch(`${base}/plugins`);
        const body = (await res.json()) as Array<{
          plugins: Array<{ config: Record<string, unknown> }>;
        }>;
        expect(body[0].plugins[0].config).toEqual({ cameras: "camera.x" });
      },
      [noToken],
    );
  });
});

// #432: the reporter typed "camera", the name of a built-in plugin, into the
// npm install dialog and npm pulled an unrelated public package.
function install(base: string, packageName: string): Promise<Response> {
  return fetch(`${base}/plugins/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packageName }),
  });
}

describe("npm install of a built-in plugin name (#432)", () => {
  beforeEach(() => {
    installCalls.length = 0;
  });

  it("rejects a built-in plugin name and never reaches the installer", async () => {
    await withRouter(async (base) => {
      const res = await install(base, "camera");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("camera");
      expect(body.error).toContain("built in");
      expect(installCalls).toEqual([]);
    });
  });

  it("matches the built-in name case-insensitively and trimmed", async () => {
    await withRouter(async (base) => {
      const res = await install(base, "  CaMeRa  ");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("built in");
      expect(installCalls).toEqual([]);
    });
  });

  it("lets a package that is not built in past the guard", async () => {
    await withRouter(async (base) => {
      // The installer is stubbed, so reaching it proves the guard passed
      // without any npm process ever starting.
      const res = await install(base, "hamh-plugin-example");
      expect(res.status).toBe(200);
      expect(installCalls).toEqual(["hamh-plugin-example"]);
    });
  });

  it("does not treat an npm-sourced plugin as built in", async () => {
    await withRouter(async (base) => {
      const res = await install(base, "hamh-plugin-thing");
      expect(res.status).toBe(200);
      expect(installCalls).toEqual(["hamh-plugin-thing"]);
    });
  });

  // A version spec walked straight past the equality compare and npm happily
  // resolved "camera@1.0.0" to the same stranger package.
  it.each([
    "camera@1.0.0",
    "camera@latest",
    "camera@^2",
  ])("rejects the version spec %s", async (spec) => {
    await withRouter(async (base) => {
      const res = await install(base, spec);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("built in");
      expect(installCalls).toEqual([]);
    });
  });

  it("still installs a scoped package carrying a version", async () => {
    await withRouter(async (base) => {
      const res = await install(base, "@acme/hamh-plugin@1.2.3");
      expect(res.status).toBe(200);
      expect(installCalls).toEqual(["@acme/hamh-plugin@1.2.3"]);
    });
  });

  // The guard used to read the built-in names off live bridges, so it went
  // blind whenever no bridge had started its plugins yet.
  it("rejects a built-in name with no bridges at all", async () => {
    await withRouter(async (base) => {
      const res = await install(base, "camera");
      expect(res.status).toBe(400);
      expect(installCalls).toEqual([]);
    }, []);
  });

  it("rejects a built-in name coming from an uploaded package", async () => {
    // The upload path reads the name from the tgz, so the guard has to run
    // there too or a package calling itself camera claims the builtin name.
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/upload`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "camera",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("built in");
    });
  });

  it("rejects a built-in name coming from a local install path", async () => {
    await withRouter(async (base) => {
      const res = await fetch(`${base}/plugins/install-local`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/opt/plugins/camera" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("built in");
    });
  });

  it("rejects a built-in name with only a server mode bridge", async () => {
    await withRouter(
      async (base) => {
        const res = await install(base, "camera");
        expect(res.status).toBe(400);
        expect(installCalls).toEqual([]);
      },
      [serverModeBridge],
    );
  });
});
