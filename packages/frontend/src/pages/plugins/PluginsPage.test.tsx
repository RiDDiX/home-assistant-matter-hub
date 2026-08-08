import {
  type BridgeDataWithMetadata,
  BridgeStatus,
} from "@home-assistant-matter-hub/common";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBridgesFromWebSocket } from "../../state/bridges/bridge-actions.ts";
import { store } from "../../state/store.ts";
import { renderWithProviders } from "../../test/render.tsx";
import { PluginsPage, pluginsEmptyState } from "./PluginsPage.tsx";

// #432 follow-up: GET /api/plugins skips server mode bridges, so a user whose
// bridges are all server mode saw "No plugins installed" and tried to install
// the built-in camera from npm.

function bridge(
  id: string,
  serverMode: boolean,
  status = BridgeStatus.Running,
): BridgeDataWithMetadata {
  return {
    id,
    name: `Bridge ${id}`,
    port: 5540,
    filter: { include: [], exclude: [], includeMode: "any" },
    featureFlags: { serverMode },
    status,
    deviceCount: 0,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
    basicInformation: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any;
}

describe("pluginsEmptyState", () => {
  const noPlugins = { bridgePlugins: [], installed: [] };

  it("keeps the generic hint while bridges are loading or failed to load", () => {
    // Never a blank page: a load failure leaves bridges undefined for good.
    expect(pluginsEmptyState({ ...noPlugins, bridges: undefined })).toBe(
      "none-installed",
    );
  });

  it("stays quiet as soon as anything is installed or loaded", () => {
    expect(
      pluginsEmptyState({
        bridges: [bridge("a", false)],
        bridgePlugins: [],
        // biome-ignore lint/suspicious/noExplicitAny: only the length matters
        installed: [{} as any],
      }),
    ).toBeUndefined();
    expect(
      pluginsEmptyState({
        bridges: [bridge("a", false)],
        bridgePlugins: [
          {
            bridgeId: "a",
            bridgeName: "a",
            // biome-ignore lint/suspicious/noExplicitAny: only the length matters
            plugins: [{} as any],
          },
        ],
        installed: [],
      }),
    ).toBeUndefined();
  });

  it("reports no bridges when none are configured", () => {
    expect(pluginsEmptyState({ ...noPlugins, bridges: [] })).toBe("no-bridges");
  });

  it("reports server mode when every bridge is server mode", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", true)],
      }),
    ).toBe("all-server-mode");
  });

  it("reports a stopped bridge when no plugin-capable bridge runs", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", false, BridgeStatus.Stopped)],
      }),
    ).toBe("bridge-not-running");
  });

  it("falls back to the install hint on a running plugin-capable bridge", () => {
    expect(
      pluginsEmptyState({
        ...noPlugins,
        bridges: [bridge("a", true), bridge("b", false)],
      }),
    ).toBe("none-installed");
  });
});

describe("PluginsPage empty state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [],
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.dispatch(setBridgesFromWebSocket([]));
  });

  it("explains server mode instead of offering an npm install", async () => {
    store.dispatch(setBridgesFromWebSocket([bridge("sm", true)]));

    renderWithProviders(<PluginsPage />);

    expect(
      await screen.findByText(/Server mode bridges host none/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No plugins installed/i)).not.toBeInTheDocument();
    // Every bridge is accounted for in the list.
    expect(screen.getByText("Bridge sm")).toBeInTheDocument();
    expect(
      screen.getByText(/Server mode bridge, hosts no plugins/i),
    ).toBeInTheDocument();
  });
});

// #432 follow-up: the docs said "configure it on the Plugins page" but the
// page had no config UI at all. The reporter clicked the plugin row expecting
// settings, so the row opens the dialog.

const pluginList = [
  {
    bridgeId: "b1",
    bridgeName: "Bridge One",
    plugins: [
      {
        name: "camera",
        version: "0.1.0",
        source: "builtin",
        enabled: true,
        config: {},
        devices: [],
      },
    ],
  },
];

const cameraSchema = {
  pluginName: "camera",
  schema: {
    title: "Camera",
    properties: {
      cameras: {
        type: "string",
        title: "Camera entity ids",
        description: "e.g. camera.front,camera.garage",
        required: true,
      },
      sensorWidth: {
        type: "number",
        title: "Sensor width (px)",
        required: false,
      },
    },
  },
};

describe("PluginsPage config dialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    store.dispatch(setBridgesFromWebSocket([]));
  });

  function stubFetch(configResponse?: { ok: boolean; body: unknown }) {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "api/plugins") {
          return { ok: true, json: async () => pluginList };
        }
        if (url === "api/plugins/b1/camera/config-schema") {
          return { ok: true, json: async () => cameraSchema };
        }
        if (url === "api/plugins/b1/camera/config") {
          return {
            ok: configResponse?.ok ?? true,
            status: 500,
            statusText: "Internal Server Error",
            json: async () => configResponse?.body ?? { success: true },
          };
        }
        return { ok: true, json: async () => [] };
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openDialog() {
    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("camera"));
    return await screen.findByLabelText(/Camera entity ids/);
  }

  function configCall(fetchMock: ReturnType<typeof stubFetch>) {
    return fetchMock.mock.calls.find(
      ([url]) => String(url) === "api/plugins/b1/camera/config",
    );
  }

  it("opens on row click and renders the schema fields", async () => {
    stubFetch();
    const camerasInput = await openDialog();
    expect(camerasInput).toBeInTheDocument();
    expect(screen.getByLabelText(/Sensor width/)).toBeInTheDocument();
  });

  it("saves the edited config to the plugin config endpoint", async () => {
    const fetchMock = stubFetch();
    const camerasInput = await openDialog();
    fireEvent.change(camerasInput, { target: { value: "camera.x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configCall(fetchMock)).toBeDefined());
    const [, init] = configCall(fetchMock)!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      config: { cameras: "camera.x" },
    });
  });

  it("keeps the dialog open and shows the error when save fails", async () => {
    stubFetch({ ok: false, body: { error: "boom from backend" } });
    const camerasInput = await openDialog();
    fireEvent.change(camerasInput, { target: { value: "camera.x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("boom from backend")).toBeInTheDocument();
    expect(screen.getByLabelText(/Camera entity ids/)).toBeInTheDocument();
  });

  it("blocks save while a required field is empty", async () => {
    stubFetch();
    const camerasInput = await openDialog();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(camerasInput, { target: { value: "camera.x" } });
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("never lets text typed into a number field reach the config", async () => {
    const fetchMock = stubFetch();
    const camerasInput = await openDialog();
    fireEvent.change(camerasInput, { target: { value: "camera.x" } });
    const width = screen.getByLabelText(/Sensor width/);
    fireEvent.change(width, { target: { value: "abc" } });
    // The number input drops non-numeric text, leaving the field empty.
    expect((width as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configCall(fetchMock)).toBeDefined());
    const [, init] = configCall(fetchMock)!;
    expect(JSON.parse(String(init?.body))).toEqual({
      config: { cameras: "camera.x" },
    });
  });
});

describe("PluginsPage config dialog hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    store.dispatch(setBridgesFromWebSocket([]));
  });

  const twoPlugins = [
    {
      bridgeId: "b1",
      bridgeName: "Bridge One",
      plugins: [
        {
          name: "alpha",
          version: "0.1.0",
          source: "npm",
          enabled: true,
          config: {},
          devices: [],
        },
        {
          name: "beta",
          version: "0.1.0",
          source: "npm",
          enabled: true,
          config: {},
          devices: [],
        },
      ],
    },
  ];

  const schemaOf = (pluginName: string, fieldTitle: string) => ({
    pluginName,
    schema: {
      title: pluginName,
      properties: {
        [`${pluginName}Field`]: {
          type: "string",
          title: fieldTitle,
          required: false,
        },
      },
    },
  });

  it("drops a stale schema response when another dialog opened since", async () => {
    let resolveAlpha!: (v: unknown) => void;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "api/plugins") {
          return { ok: true, json: async () => twoPlugins };
        }
        if (url === "api/plugins/b1/alpha/config-schema") {
          return {
            ok: true,
            json: () => new Promise((resolve) => (resolveAlpha = resolve)),
          };
        }
        if (url === "api/plugins/b1/beta/config-schema") {
          return { ok: true, json: async () => schemaOf("beta", "Beta field") };
        }
        if (url.endsWith("/config")) {
          return { ok: true, json: async () => ({ success: true }) };
        }
        return { ok: true, json: async () => [] };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("alpha"));
    fireEvent.click(await screen.findByText("beta"));
    const betaField = await screen.findByLabelText("Beta field");

    // Alpha's schema arrives late; it must not replace beta's dialog. Flush
    // the microtask chain so the late response has actually been processed
    // before asserting it changed nothing.
    await act(async () => {
      resolveAlpha(schemaOf("alpha", "Alpha field"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("Alpha field")).not.toBeInTheDocument();
    expect(betaField).toBeInTheDocument();

    fireEvent.change(betaField, { target: { value: "from-beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url]) => String(url) === "api/plugins/b1/beta/config",
        ),
      ).toBeDefined(),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => String(url) === "api/plugins/b1/beta/config",
    )!;
    expect(JSON.parse(String(init?.body))).toEqual({
      config: { betaField: "from-beta" },
    });
  });

  it("shows the failure instead of claiming the plugin has no settings", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "api/plugins") {
        return { ok: true, json: async () => pluginList };
      }
      if (url === "api/plugins/b1/camera/config-schema") {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({ error: "bridge is stopped" }),
        };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("camera"));

    expect(await screen.findByText("bridge is stopped")).toBeInTheDocument();
    expect(
      screen.queryByText("This plugin has no settings."),
    ).not.toBeInTheDocument();
  });

  it("keeps config keys the schema does not list and drops blanked fields", async () => {
    const withExtras = [
      {
        bridgeId: "b1",
        bridgeName: "Bridge One",
        plugins: [
          {
            name: "camera",
            version: "0.1.0",
            source: "builtin",
            enabled: true,
            config: { cameras: "camera.old", sensorWidth: 640, extra: "keep" },
            devices: [],
          },
        ],
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "api/plugins") {
          return { ok: true, json: async () => withExtras };
        }
        if (url === "api/plugins/b1/camera/config-schema") {
          return { ok: true, json: async () => cameraSchema };
        }
        if (url === "api/plugins/b1/camera/config") {
          return { ok: true, json: async () => ({ success: true }) };
        }
        return { ok: true, json: async () => [] };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("camera"));
    const width = await screen.findByLabelText(/Sensor width/);
    expect((width as HTMLInputElement).value).toBe("640");
    fireEvent.change(width, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url]) => String(url) === "api/plugins/b1/camera/config",
        ),
      ).toBeDefined(),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([url]) => String(url) === "api/plugins/b1/camera/config",
    )!;
    expect(JSON.parse(String(init?.body))).toEqual({
      config: { cameras: "camera.old", extra: "keep" },
    });
  });

  it("stays open when closed while a save is in flight", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "api/plugins") {
          return { ok: true, json: async () => pluginList };
        }
        if (url === "api/plugins/b1/camera/config-schema") {
          return { ok: true, json: async () => cameraSchema };
        }
        if (url === "api/plugins/b1/camera/config") {
          // never settles, the save stays in flight
          return new Promise(() => {}) as never;
        }
        return { ok: true, json: async () => [] };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("camera"));
    const camerasInput = await screen.findByLabelText(/Camera entity ids/);
    fireEvent.change(camerasInput, { target: { value: "camera.x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // A dialog that took the Escape unmounts once its exit transition ends,
    // so outlive the transition before asserting it is still there.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("url-encodes scoped plugin names", async () => {
    const scoped = [
      {
        bridgeId: "b1",
        bridgeName: "Bridge One",
        plugins: [
          {
            name: "@scope/cam",
            version: "0.1.0",
            source: "npm",
            enabled: true,
            config: {},
            devices: [],
          },
        ],
      },
    ];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === "api/plugins") {
          return { ok: true, json: async () => scoped };
        }
        return { ok: true, json: async () => ({ schema: null }) };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("@scope/cam"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) === "api/plugins/b1/%40scope%2Fcam/config-schema",
        ),
      ).toBe(true),
    );
  });

  it("masks token fields", async () => {
    const tokenSchema = {
      pluginName: "camera",
      schema: {
        title: "Camera",
        properties: {
          haToken: { type: "string", title: "HA token", required: false },
        },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "api/plugins") {
        return { ok: true, json: async () => pluginList };
      }
      if (url === "api/plugins/b1/camera/config-schema") {
        return { ok: true, json: async () => tokenSchema };
      }
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<PluginsPage />);
    fireEvent.click(await screen.findByText("camera"));
    const token = await screen.findByLabelText("HA token");
    expect((token as HTMLInputElement).type).toBe("password");
  });
});
