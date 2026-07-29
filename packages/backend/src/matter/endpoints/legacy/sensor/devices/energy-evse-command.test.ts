import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../../create-legacy-endpoint-type.js";

// The default EnergyEvseServer has no command implementations. The subclass
// dispatches HA actions: EnableCharging starts the mapped switch and writes the
// clamped current, Disable stops the switch.

const EVSE = "sensor.wallbox_status";
const SWITCH = "switch.wallbox_charging";
const LIMIT = "number.wallbox_current_limit";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let captured: Array<{ action: HomeAssistantAction; entityId: string }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-evse-cmd-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  captured = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction, entityId: string) {
      captured.push({ action, entityId });
    },
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
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any),
  );
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
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

function statusEntity(value: string): HomeAssistantEntityInformation {
  const state = {
    entity_id: EVSE,
    state: value,
    attributes: { friendly_name: EVSE },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: EVSE, state: state as any };
}

async function mount(
  overrides?: Partial<
    import("@home-assistant-matter-hub/common").EntityMappingConfig
  >,
  // biome-ignore lint/suspicious/noExplicitAny: agent typed loosely for the test
): Promise<Endpoint<any>> {
  const type = createLegacyEndpointType(statusEntity("idle"), {
    entityId: EVSE,
    matterDeviceType: "evse",
    chargingSwitchEntity: SWITCH,
    currentLimitEntity: LIMIT,
    ...overrides,
  });
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `evse-cmd-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "evse-cmd" });
  await aggregator.add(endpoint);
  return endpoint;
}

describe("energy evse commands", () => {
  it("enableCharging turns the switch on and writes clamped amps", async () => {
    const endpoint = await mount();
    captured = [];
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: null,
        minimumChargeCurrent: 6000,
        maximumChargeCurrent: 16000,
      }),
    );

    const on = captured.find((c) => c.action.action === "switch.turn_on");
    expect(on).toBeDefined();
    expect(on?.action.target).toBe(SWITCH);

    const setLimit = captured.find(
      (c) => c.action.action === "number.set_value",
    );
    expect(setLimit).toBeDefined();
    expect(setLimit?.action.target).toBe(LIMIT);
    // 16000 mA -> 16 A, within the 6..32 circuit range.
    expect((setLimit?.action.data as { value: number }).value).toBe(16);

    // Optimistic supplyState flip to ChargingEnabled.
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.supplyState)).toBe(1);
    });
  });

  it("clamps an out-of-range max current to the circuit capacity", async () => {
    const endpoint = await mount();
    captured = [];
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: null,
        minimumChargeCurrent: 6000,
        maximumChargeCurrent: 200000, // 200 A
      }),
    );
    const setLimit = captured.find(
      (c) => c.action.action === "number.set_value",
    );
    // 200 A request clamps to the advertised 32 A circuit.
    expect((setLimit?.action.data as { value: number }).value).toBe(32);
  });

  it("reflects the enableCharging command fields into state (clamped)", async () => {
    const endpoint = await mount();
    captured = [];
    const until = Math.floor(Date.now() / 1000) + 3600; // 1h ahead (unix s)
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: until,
        minimumChargeCurrent: 1000, // below the 6000 mA floor
        maximumChargeCurrent: 200000, // above the 32000 mA circuit cap
      }),
    );

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      const s = (agent as any).energyEvse.state;
      expect(Number(s.chargingEnabledUntil)).toBe(until);
      expect(Number(s.minimumChargeCurrent)).toBe(6000);
      expect(Number(s.maximumChargeCurrent)).toBe(32000);
      expect(Number(s.supplyState)).toBe(1); // ChargingEnabled
    });
  });

  it("treats a past chargingEnabledUntil as disable", async () => {
    const endpoint = await mount();
    captured = [];
    const past = Math.floor(Date.now() / 1000) - 10;
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: past,
        minimumChargeCurrent: 6000,
        maximumChargeCurrent: 16000,
      }),
    );

    // A window that already elapsed must stop, not start, charging.
    expect(captured.find((c) => c.action.action === "switch.turn_on")).toBe(
      undefined,
    );
    expect(
      captured.find((c) => c.action.action === "switch.turn_off"),
    ).toBeDefined();
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.supplyState)).toBe(0);
    });
  });

  it("arms an expiry that turns the switch off when the window elapses", async () => {
    const endpoint = await mount();
    captured = [];
    const until = Math.floor(Date.now() / 1000) + 1; // ~1s ahead
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: until,
        minimumChargeCurrent: 6000,
        maximumChargeCurrent: 16000,
      }),
    );
    // Charging starts immediately.
    expect(
      captured.find((c) => c.action.action === "switch.turn_on"),
    ).toBeDefined();

    // Wait past the 1s window for the expiry timer to fire.
    await new Promise((r) => setTimeout(r, 1300));

    expect(
      captured.find((c) => c.action.action === "switch.turn_off"),
    ).toBeDefined();
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      const s = (agent as any).energyEvse.state;
      expect(Number(s.supplyState)).toBe(0); // Disabled
      expect(s.chargingEnabledUntil).toBeNull();
    });
  });

  it("clamps a live current-limit feed into the circuit range", async () => {
    // The mapped number entity reports 80 A; MaximumChargeCurrent must clamp
    // to the advertised 32 A (32000 mA) circuit, not 80000 mA.
    env.set(EntityStateProvider, {
      getState: () => undefined,
      getNumericState: (id: string) => (id === LIMIT ? 80 : null),
      getBatteryPercent: () => null,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);
    const endpoint = await mount();

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.maximumChargeCurrent)).toBe(
        32000,
      );
    });
  });

  it("rounds a between-amp max current down, never past the bound", async () => {
    const endpoint = await mount();
    captured = [];
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: null,
        minimumChargeCurrent: null,
        maximumChargeCurrent: 6500,
      }),
    );
    const setLimit = captured.find(
      (c) => c.action.action === "number.set_value",
    );
    // 6500 mA floors to 6 A; 7 A would exceed the controller's bound.
    expect((setLimit?.action.data as { value: number }).value).toBe(6);
  });

  it("disable resets a current-limit-only evse without a switch", async () => {
    const endpoint = await mount({ chargingSwitchEntity: undefined });
    captured = [];
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.enableCharging({
        chargingEnabledUntil: null,
        minimumChargeCurrent: null,
        maximumChargeCurrent: 16000,
      }),
    );
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.supplyState)).toBe(1);
    });

    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.disable(),
    );
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.supplyState)).toBe(0);
    });
  });

  it("disable turns the switch off and flips supplyState to Disabled", async () => {
    const endpoint = await mount();
    captured = [];
    await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: invoke command handler
      (agent as any).energyEvse.disable(),
    );

    const off = captured.find((c) => c.action.action === "switch.turn_off");
    expect(off).toBeDefined();
    expect(off?.action.target).toBe(SWITCH);

    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect(Number((agent as any).energyEvse.state.supplyState)).toBe(0);
    });
  });
});
