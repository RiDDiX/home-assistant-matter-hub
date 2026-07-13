import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HomeAssistantEntityInformation,
  LightDeviceColorMode,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ColorControl } from "@matter/main/clusters";
import { LevelControl } from "@matter/main/clusters/level-control";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LightDevice } from "./index.js";

// #412 fast-follow: light step commands finally call HA. This pins the level
// and color-temp step math, proves rapid steps accumulate off the optimistic
// Matter state (defect 1), and proves a huge color-temp down-step clamps to the
// boundary instead of being dropped (defect 2).

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-step412-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
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
});

afterEach(async () => {
  // Close from afterEach so a failing assertion still tears the server down.
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

interface CtOpts {
  brightness?: number | null;
  kelvin?: number | null;
  state?: string;
}

// A color-temp light (min 2000K, max 6500K). Brightness and kelvin are optional
// so the same fixture covers an off light with no reported values.
function ctLight(
  entityId: string,
  { brightness = null, kelvin = null, state = "on" }: CtOpts,
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state,
    attributes: {
      friendly_name: "CT Light",
      supported_color_modes: [LightDeviceColorMode.COLOR_TEMP],
      color_mode: LightDeviceColorMode.COLOR_TEMP,
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6500,
      brightness,
      color_temp_kelvin: kelvin,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `step412-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(LightDevice({ entity } as never), {
    id: "light",
  });
  await aggregator.add(endpoint);
  return endpoint;
}

async function stepLevel(
  endpoint: Endpoint,
  stepMode: LevelControl.StepMode,
  stepSize: number,
) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const a = agent as any;
    await a.levelControl.step({
      stepMode,
      stepSize,
      transitionTime: 0,
      optionsMask: {},
      optionsOverride: {},
    });
  });
}

async function stepColorTemp(
  endpoint: Endpoint,
  stepMode: ColorControl.StepMode,
  stepSize: number,
) {
  await endpoint.act(async (agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller command
    const a = agent as any;
    await a.colorControl.stepColorTemperature({
      stepMode,
      stepSize,
      transitionTime: 0,
      colorTemperatureMinimumMireds: 0,
      colorTemperatureMaximumMireds: 0,
      optionsMask: {},
      optionsOverride: {},
    });
  });
}

function lastTurnOn(): Record<string, unknown> | undefined {
  const call = calls.filter((c) => c.action === "light.turn_on").at(-1);
  return call?.data as Record<string, unknown> | undefined;
}

describe("light step control (#412)", () => {
  it("accumulates rapid level steps off the optimistic state", async () => {
    const endpoint = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );

    // Two step-ups with no HA state update in between. Each must build on the
    // previous optimistic level, not re-read the stale brightness of 128.
    calls.length = 0;
    await stepLevel(endpoint, LevelControl.StepMode.Up, 25);
    const first = lastTurnOn()?.brightness as number;

    calls.length = 0;
    await stepLevel(endpoint, LevelControl.StepMode.Up, 25);
    const second = lastTurnOn()?.brightness as number;

    // brightness values are captured above, so afterEach handles the close.
    // base 127 -> 152 -> brightness round(152/254*255) = 153
    expect(first).toBe(153);
    // base 152 -> 177 -> brightness round(177/254*255) = 178
    expect(second).toBe(178);
    expect(second).toBeGreaterThan(first);
  });

  it("maps a single level step up and down (#402 math)", async () => {
    const up = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    await stepLevel(up, LevelControl.StepMode.Up, 25);
    // round(128/255*254) = 127; (127+25)/254*255 rounds to 153
    expect(lastTurnOn()?.brightness).toBe(153);
    // Close the first node before the second mount replaces server.
    await server?.close().catch(() => {});
    server = undefined;

    const down = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    await stepLevel(down, LevelControl.StepMode.Down, 25);
    // (127-25)/254*255 rounds to 102
    expect(lastTurnOn()?.brightness).toBe(102);
  });

  it("does nothing when a level step cannot change the value", async () => {
    // Already at max: a step up must not call HA.
    const max = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 255, kelvin: 4000 }),
    );
    calls.length = 0;
    await stepLevel(max, LevelControl.StepMode.Up, 25);
    expect(calls.filter((c) => c.action === "light.turn_on")).toHaveLength(0);
    // Close the first node before the second mount replaces server.
    await server?.close().catch(() => {});
    server = undefined;

    // Off light with no brightness: a step must not turn it on.
    const off = await mount(
      ctLight(`light.step412_${counter}`, {
        brightness: null,
        kelvin: null,
        state: "off",
      }),
    );
    calls.length = 0;
    await stepLevel(off, LevelControl.StepMode.Up, 25);
    expect(calls.filter((c) => c.action === "light.turn_on")).toHaveLength(0);
  });

  it("steps color temperature warmer and clamps at min kelvin", async () => {
    const warm = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    await stepColorTemp(warm, ColorControl.StepMode.Up, 50);
    const warmerKelvin = lastTurnOn()?.color_temp_kelvin as number;
    // Up means more mireds, i.e. warmer / lower kelvin.
    expect(warmerKelvin).toBeLessThan(4000);
    expect(warmerKelvin).toBeGreaterThan(2000);
    // Close the first node before the second mount replaces server.
    await server?.close().catch(() => {});
    server = undefined;

    const clamp = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    await stepColorTemp(clamp, ColorControl.StepMode.Up, 1000);
    expect(lastTurnOn()?.color_temp_kelvin as number).toBeCloseTo(2000, 0);
  });

  it("clamps a huge color-temp down-step to max kelvin (defect 2)", async () => {
    const endpoint = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    // Down by 1000 mireds drives the stepped mireds negative. Pre-fix that
    // converts to null kelvin and the command is dropped; it must clamp to max.
    await stepColorTemp(endpoint, ColorControl.StepMode.Down, 1000);
    expect(lastTurnOn()?.color_temp_kelvin as number).toBeCloseTo(6500, 0);
  });

  it("returns to the start on a rapid color-temp reversal (defect 1)", async () => {
    const endpoint = await mount(
      ctLight(`light.step412_${counter}`, { brightness: 128, kelvin: 4000 }),
    );
    calls.length = 0;
    // Up then down by the same size with no HA update between. The down step
    // must base off the optimistic mireds and undo the up step, not read the
    // stale 4000K HA value and drop the reversal as a no-op.
    await stepColorTemp(endpoint, ColorControl.StepMode.Up, 50);
    await stepColorTemp(endpoint, ColorControl.StepMode.Down, 50);

    const turnOns = calls.filter((c) => c.action === "light.turn_on");
    expect(turnOns).toHaveLength(2);
    const back = turnOns.at(-1)?.data as Record<string, unknown>;
    expect(back.color_temp_kelvin as number).toBeCloseTo(4000, 0);
  });
});
