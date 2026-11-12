import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { ClimateDevice } from "./index.js";

// Off climates are nudged +1 so a same-value controller write still fires
// $Changing (#176). Without a target temperature from HA the setpoint falls
// back to the stored, already nudged value, which must not be nudged again.

let dir: string;
let env: Environment;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-offnudge-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
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

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function climateEntity(
  state: string,
  attributes: Record<string, unknown>,
): HomeAssistantEntityInformation {
  const s = {
    entity_id: "climate.ac",
    state,
    attributes: {
      friendly_name: "AC",
      hvac_modes: ["off", "heat", "cool"],
      min_temp: 7,
      max_temp: 35,
      current_temperature: 21,
      supported_features: 385,
      ...attributes,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "climate.ac", state: s as any };
}

async function mount(entity: HomeAssistantEntityInformation) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `offnudge-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(ClimateDevice({ entity } as never), {
    id: "ac",
  });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

function setpoints(endpoint: Endpoint) {
  // biome-ignore lint/suspicious/noExplicitAny: inspect cluster state
  const t = (endpoint.state as any).thermostat;
  return {
    heat: t.occupiedHeatingSetpoint as number,
    cool: t.occupiedCoolingSetpoint as number,
  };
}

async function updates(
  endpoint: Endpoint,
  state: string,
  attributes: Record<string, unknown>,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    await endpoint.setStateOf(HomeAssistantEntityBehavior, {
      entity: climateEntity(state, {
        ...attributes,
        current_temperature: 21 + (i % 2) / 10,
      }),
    });
  }
}

describe("Off setpoint nudge does not accumulate", () => {
  it("keeps both setpoints fixed over 50 updates without a temperature", async () => {
    const { server, endpoint } = await mount(climateEntity("off", {}));
    try {
      // the first update after registration still nudges the defaults
      expect(setpoints(endpoint)).toEqual({ heat: 2001, cool: 2401 });
      await updates(endpoint, "off", {}, 50);
      expect(setpoints(endpoint)).toEqual({ heat: 2001, cool: 2401 });
    } finally {
      await server.close();
    }
  });

  it("nudges a fresh temperature from HA once and keeps it", async () => {
    const { server, endpoint } = await mount(
      climateEntity("off", { temperature: 22 }),
    );
    try {
      await updates(endpoint, "off", { temperature: 22 }, 50);
      expect(setpoints(endpoint)).toEqual({ heat: 2201, cool: 2201 });
    } finally {
      await server.close();
    }
  });

  it("nudges a new temperature from HA while Off", async () => {
    const { server, endpoint } = await mount(
      climateEntity("off", { temperature: 22 }),
    );
    try {
      await updates(endpoint, "off", { temperature: 23 }, 1);
      expect(setpoints(endpoint)).toEqual({ heat: 2301, cool: 2301 });
    } finally {
      await server.close();
    }
  });

  it("nudges a new temperature that equals the stored nudged value", async () => {
    const { server, endpoint } = await mount(
      climateEntity("off", { temperature: 22 }),
    );
    try {
      expect(setpoints(endpoint)).toEqual({ heat: 2201, cool: 2201 });
      await updates(endpoint, "off", { temperature: 22.01 }, 1);
      expect(setpoints(endpoint)).toEqual({ heat: 2202, cool: 2202 });
    } finally {
      await server.close();
    }
  });

  it("nudges a stored setpoint the lowered max_temp clamped", async () => {
    const { server, endpoint } = await mount(climateEntity("off", {}));
    try {
      // clamped to the 20.00 limit, nudged one step inside it
      await updates(endpoint, "off", { max_temp: 20 }, 1);
      expect(setpoints(endpoint)).toEqual({ heat: 1999, cool: 1999 });
      await updates(endpoint, "off", { max_temp: 20 }, 1);
      expect(setpoints(endpoint)).toEqual({ heat: 1999, cool: 1999 });
    } finally {
      await server.close();
    }
  });

  it("nudges once when HA drops the temperature on the way to Off", async () => {
    const { server, endpoint } = await mount(
      climateEntity("heat", { temperature: 22 }),
    );
    try {
      expect(setpoints(endpoint).heat).toBe(2200);
      await updates(endpoint, "off", {}, 50);
      expect(setpoints(endpoint).heat).toBe(2201);
    } finally {
      await server.close();
    }
  });
});
