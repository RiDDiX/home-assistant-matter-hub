import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, Logger, VariableService } from "@matter/general";
import {
  Endpoint,
  type EndpointType,
  type MutableEndpoint,
  VendorId,
} from "@matter/main";
import { RvcCleanMode } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { RvcCleanModeServer } from "../../../behaviors/rvc-clean-mode-server.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { VacuumDevice } from "./index.js";

// "Can not use unsupported mode: 50. Allowed modes are 0, 10, 11, 12, 13":
// the clean type the vacuum reports live was not in the cleaning mode
// options seen at registration, and the vacuum failed to mount.

const VACUUM = "vacuum.murre";
const MOP = "select.murre_mop";
const CLEAN = "select.murre_cleaning_mode";
const fan = ["quiet", "standard", "strong", "turbo"];

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let states: Record<string, { state: string; attributes: object }>;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-clean-mode-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  states = {
    [MOP]: { state: "low", attributes: { options: ["low", "medium", "high"] } },
  };
  env.set(HomeAssistantActions, {
    call: (a: HomeAssistantAction) => calls.push(a),
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(
    BridgeDataProvider,
    new BridgeDataProvider({
      id: "b",
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as any);
  env.set(EntityStateProvider, {
    getState: (id: string) => states[id],
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function vacuum(
  attributes: Record<string, unknown> = {},
): HomeAssistantEntityInformation {
  const s = {
    entity_id: VACUUM,
    state: "docked",
    attributes: {
      friendly_name: "Murre",
      supported_features: 0,
      fan_speed_list: fan,
      fan_speed: "strong",
      ...attributes,
    },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: new Date().toISOString(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: VACUUM, state: s as any };
}

function vacuumType(
  options: string[],
  attributes: Record<string, unknown>,
  mapping: Partial<EntityMappingConfig> = { mopIntensityEntity: MOP },
) {
  const type = VacuumDevice(
    {
      entity: vacuum(attributes),
      mapping: { entityId: VACUUM, ...mapping },
    } as HomeAssistantEntityBehavior.State,
    false,
    options,
  );
  if (!type) throw new Error("no endpoint type");
  return type;
}

async function mount(type: EndpointType) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "clean-mode-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "vacuum_murre" });
  await aggregator.add(endpoint);
  return endpoint;
}

function cleanMode(endpoint: Endpoint) {
  // biome-ignore lint/suspicious/noExplicitAny: behavior state
  const s = (endpoint.state as any).rvcCleanMode;
  return {
    current: s.currentMode as number,
    supported: (s.supportedModes as { mode: number }[]).map((m) => m.mode),
  };
}

async function haState(
  endpoint: Endpoint,
  attributes: Record<string, unknown>,
) {
  await endpoint.setStateOf(HomeAssistantEntityBehavior, {
    entity: vacuum(attributes),
  });
}

describe("vacuum clean mode bring-up", () => {
  it.each([
    ["mop", ["vacuum"]],
    ["vacuum_and_mop", ["vacuum"]],
    ["mop", ["standard", "deep", "deep_plus", "fast", "custom"]],
  ])("mounts with live cleaning_mode %s when only %j was registered", async (live, options) => {
    const endpoint = await mount(vacuumType(options, { cleaning_mode: live }));
    const { current, supported } = cleanMode(endpoint);
    expect(supported).toEqual([0, 10, 11, 12, 13]);
    expect(supported).toContain(current);
  });

  it("restarts after the stored mop mode left the supported modes", async () => {
    const first = await mount(
      vacuumType(["vacuum", "mop"], { cleaning_mode: "mop" }),
    );
    expect(cleanMode(first).current).toBe(50);
    await server?.close();

    const endpoint = await mount(
      vacuumType(["vacuum"], { cleaning_mode: "mop" }),
    );
    const { current, supported } = cleanMode(endpoint);
    expect(supported).toEqual([0, 10, 11, 12, 13]);
    expect(supported).toContain(current);
  });

  it("commits the first supported mode when a getter reports an unlisted one", async () => {
    const vacuumOnly = {
      label: "Vacuum",
      mode: 0,
      modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
    };
    let reported = 77;
    const type = (vacuumType(["vacuum"], {}) as MutableEndpoint).with(
      RvcCleanModeServer(
        {
          getCurrentMode: () => reported,
          getSupportedModes: () => [vacuumOnly],
          setCleanMode: () => undefined,
        },
        { supportedModes: [vacuumOnly], currentMode: 0 },
      ),
    );
    const endpoint = await mount(type);
    expect(cleanMode(endpoint).current).toBe(0);

    reported = 78;
    await haState(endpoint, {});
    expect(cleanMode(endpoint).current).toBe(0);
  });

  it("warns once per unlisted value and again after a listed one", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    const vacuumOnly = {
      label: "Vacuum",
      mode: 0,
      modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
    };
    let reported = 77;
    const type = (vacuumType(["vacuum"], {}) as MutableEndpoint).with(
      RvcCleanModeServer(
        {
          getCurrentMode: () => reported,
          getSupportedModes: () => [vacuumOnly],
          setCleanMode: () => undefined,
        },
        { supportedModes: [vacuumOnly], currentMode: 0 },
      ),
    );
    const warnings = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("is not supported"))
        .length;
    try {
      const endpoint = await mount(type);
      await haState(endpoint, {});
      await haState(endpoint, {});
      expect(warnings()).toBe(1);

      reported = 0;
      await haState(endpoint, {});
      reported = 77;
      await haState(endpoint, {});
      expect(warnings()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the mode while the cleaning mode select is unavailable", async () => {
    states[CLEAN] = {
      state: "mop",
      attributes: { options: ["vacuum", "mop"] },
    };
    const endpoint = await mount(
      vacuumType(["vacuum", "mop"], {}, { cleaningModeEntity: CLEAN }),
    );
    expect(cleanMode(endpoint).current).toBe(2);

    states[CLEAN] = { state: "unavailable", attributes: {} };
    await haState(endpoint, {});
    expect(cleanMode(endpoint).current).toBe(2);
  });

  it("reports the plain mop mode while the mop select is unavailable", async () => {
    states[CLEAN] = {
      state: "mop",
      attributes: { options: ["vacuum", "mop"] },
    };
    states[MOP] = {
      state: "medium",
      attributes: { options: ["low", "medium", "high"] },
    };
    const endpoint = await mount(
      vacuumType(
        ["vacuum", "mop"],
        {},
        { cleaningModeEntity: CLEAN, mopIntensityEntity: MOP },
      ),
    );
    expect(cleanMode(endpoint).current).toBe(51);

    states[MOP] = { state: "unavailable", attributes: {} };
    await haState(endpoint, {});
    expect(cleanMode(endpoint).current).toBe(2);
  });

  it("does not hold a mode change that sent nothing", async () => {
    const endpoint = await mount(vacuumType([], {}, {}));
    expect(cleanMode(endpoint).current).toBe(12);

    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
      await (agent as any).rvcCleanMode.changeToMode({ newMode: 0 });
    });
    expect(calls).toEqual([]);
    await haState(endpoint, {});
    expect(cleanMode(endpoint).current).toBe(12);
  });

  it("drops an older held mode when a later change sends nothing", async () => {
    const endpoint = await mount(vacuumType([], {}, {}));
    const change = (newMode: number) =>
      endpoint.act(async (agent) => {
        // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
        await (agent as any).rvcCleanMode.changeToMode({ newMode });
      });

    await change(13);
    expect(calls).toHaveLength(1);
    await change(0);
    expect(calls).toHaveLength(1);
    await haState(endpoint, {});
    expect(cleanMode(endpoint).current).toBe(12);
  });
});

describe("vacuum room ids", () => {
  function areas(endpoint: Endpoint) {
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    const st = endpoint.state as any;
    return {
      areas: (
        st.serviceArea.supportedAreas as {
          areaId: number;
          areaInfo: { locationInfo: { locationName: string } };
        }[]
      ).map((a) => [a.areaId, a.areaInfo.locationInfo.locationName]),
      modes: (st.rvcRunMode.supportedModes as { mode: number; label: string }[])
        .slice(2)
        .map((m) => [m.mode, m.label]),
    };
  }

  it("keeps one room per shared id across areas and modes", async () => {
    const endpoint = await mount(
      vacuumType([], { rooms: { zebra: 4, alpha: 4, kitchen: 5 } }, {}),
    );
    // the first room in parse order is the one the room lookups find
    expect(areas(endpoint)).toEqual({
      areas: [
        [4, "Zebra"],
        [5, "Kitchen"],
      ],
      modes: [
        [105, "Kitchen"],
        [104, "Zebra"],
      ],
    });
  });

  it("mounts with a negative room id, without that room", async () => {
    const endpoint = await mount(
      vacuumType([], { rooms: { den: -5, kitchen: 5 } }, {}),
    );
    expect(areas(endpoint)).toEqual({
      areas: [[5, "Kitchen"]],
      modes: [[105, "Kitchen"]],
    });
  });
});

describe("vacuum run mode restart", () => {
  it("restarts with the stored room mode gone instead of failing the endpoint", async () => {
    const first = await mount(
      vacuumType([], { rooms: { kitchen: 5, den: 6 } }, {}),
    );
    // A seeded value is not stored, a runtime change is
    await first.set({ rvcRunMode: { currentMode: 106 } });
    await server?.close();

    const endpoint = await mount(vacuumType([], { rooms: { kitchen: 5 } }, {}));
    // biome-ignore lint/suspicious/noExplicitAny: behavior state
    expect((endpoint.state as any).rvcRunMode.currentMode).toBe(0);
  });
});
