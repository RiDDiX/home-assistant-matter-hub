import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EntityMappingConfig,
  HomeAssistantEntityInformation,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { FanDevice } from "./index.js";

// #387 opt-in: Apple Home's power button writes percentSetting=100 before
// turning on. With fanRestoreSpeedOnPowerOn the bridge ignores that injected
// value while the fan is off and restores the last speed instead.

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-fan-restore-"));
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

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fanEntity(): HomeAssistantEntityInformation {
  const full = {
    entity_id: "fan.test",
    state: "off",
    attributes: {
      friendly_name: "Fan",
      supported_features: 1,
      percentage: 0,
      percentage_step: 1,
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "fan.test", state: full as any };
}

// Mount an off fan with a remembered speed of 24, then have a controller write
// percentSetting=100 while off (the Apple Home power button). Returns the
// percentage HAMH sends to HA.
async function powerOnPercentage(
  mapping: EntityMappingConfig,
): Promise<number | undefined> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-restore-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({ entity: fanEntity(), mapping } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
    const fc = (agent as any).fanControl;
    fc.lastNonZeroPercent = 24; // remembered speed from before it was turned off
    fc.targetPercentSettingChanged(100, 0, { subject: {} });
  });
  await server.close().catch(() => {});

  const setPct = calls.find((c) => c.action === "fan.set_percentage");
  return (setPct?.data as { percentage?: number } | undefined)?.percentage;
}

// Same flow, but read back the Matter cluster after the restore. Apple's
// injected 100 must be replaced in the cluster, not just in the HA call.
async function powerOnClusterState(mapping: EntityMappingConfig): Promise<{
  percentSetting?: number | null;
  percentCurrent?: number | null;
  speedSetting?: number | null;
}> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-restore-state-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({ entity: fanEntity(), mapping } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);

  const out: {
    percentSetting?: number | null;
    percentCurrent?: number | null;
    speedSetting?: number | null;
  } = {};
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
    const fc = (agent as any).fanControl;
    fc.state.percentSetting = 100; // Apple Home's injected power-on value
    fc.lastNonZeroPercent = 24;
    fc.lastNonZeroSpeed = 2;
    fc.targetPercentSettingChanged(100, 0, { subject: {} });
    out.percentSetting = fc.state.percentSetting;
    out.percentCurrent = fc.state.percentCurrent;
    out.speedSetting = fc.state.speedSetting;
  });
  await server.close().catch(() => {});
  return out;
}

// Some integrations (ha_xiaomi_home) accept fan.set_percentage but never
// report a percentage attribute, so update() alone can't capture the last
// speed. The controller write itself must be remembered (#387).
async function powerOnAfterMatterSpeedWrite(
  mapping: EntityMappingConfig,
): Promise<number | undefined> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-restore-write-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const entity = fanEntity();
  // Fan is on but HA never fills the percentage attribute.
  entity.state.state = "on";
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  (entity.state.attributes as any).percentage = null;
  const endpoint = new Endpoint(FanDevice({ entity, mapping } as never), {
    id: "fan",
  });
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller writes
    const a = agent as any;
    a.onOff.state.onOff = true;
    a.fanControl.targetPercentSettingChanged(50, 0, { subject: {} }); // user picks 50%
    a.onOff.state.onOff = false; // fan turned off
    a.fanControl.targetPercentSettingChanged(100, 0, { subject: {} }); // Apple power button
  });
  await server.close().catch(() => {});

  const setPct = calls.filter((c) => c.action === "fan.set_percentage").at(-1);
  return (setPct?.data as { percentage?: number } | undefined)?.percentage;
}

// Reproduce the Apple race: onOff.on already flipped the Matter onOff true in a
// separate frame before the percentSetting reactor runs. The HA state is still
// off, so the restore must still fire (#387).
async function powerOnPercentageOnOffRace(
  mapping: EntityMappingConfig,
): Promise<number | undefined> {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "fan-restore-race-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(
    FanDevice({ entity: fanEntity(), mapping } as never),
    { id: "fan" },
  );
  await aggregator.add(endpoint);

  calls.length = 0;
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: drive the controller write
    const a = agent as any;
    a.onOff.state.onOff = true; // onOff.on already processed (the race)
    a.fanControl.lastNonZeroPercent = 24;
    a.fanControl.targetPercentSettingChanged(100, 0, { subject: {} });
  });
  await server.close().catch(() => {});

  const setPct = calls.find((c) => c.action === "fan.set_percentage");
  return (setPct?.data as { percentage?: number } | undefined)?.percentage;
}

describe("fan restore speed on power-on (#387)", () => {
  it("restores the last speed when the flag is on", async () => {
    const pct = await powerOnPercentage({
      entityId: "fan.test",
      fanRestoreSpeedOnPowerOn: true,
    });
    expect(pct).toBe(24);
  });

  it("keeps the controller value when the flag is off", async () => {
    const pct = await powerOnPercentage({ entityId: "fan.test" });
    expect(pct).toBe(100);
  });

  it("patches the cluster state to the restored speed (flag on)", async () => {
    const s = await powerOnClusterState({
      entityId: "fan.test",
      fanRestoreSpeedOnPowerOn: true,
    });
    expect(s.percentSetting).toBe(24);
    expect(s.percentCurrent).toBe(24);
    expect(s.speedSetting).toBe(2);
  });

  it("restores even when onOff already flipped true (Apple race)", async () => {
    const pct = await powerOnPercentageOnOffRace({
      entityId: "fan.test",
      fanRestoreSpeedOnPowerOn: true,
    });
    expect(pct).toBe(24);
  });

  it("remembers a speed set via Matter when HA reports no percentage", async () => {
    const pct = await powerOnAfterMatterSpeedWrite({
      entityId: "fan.test",
      fanRestoreSpeedOnPowerOn: true,
    });
    expect(pct).toBe(50);
  });
});
