import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { OperationalState } from "@matter/main/clusters/operational-state";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../create-legacy-endpoint-type.js";

// #486: the state table only knew plain switch words, so a Home Connect
// dishwasher (whose sensor reports run/pause/error, see
// homeassistant/components/home_connect/sensor.py) read as Stopped for every
// state but "finished", and the Error state declared in operationalStateList
// was unreachable.

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-dishwasher-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantActions, { call() {} } as any);
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
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  env.set(HomeAssistantConfig, { unitSystem: { temperature: "°C" } } as any);
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

function entity(state: string): HomeAssistantEntityInformation {
  const s = {
    entity_id: "switch.dishwasher",
    state,
    attributes: { friendly_name: "Dishwasher" },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: "switch.dishwasher", state: s as any };
}

async function bringUp(haState: string) {
  const type = createLegacyEndpointType(entity(haState), {
    entityId: "switch.dishwasher",
    matterDeviceType: "dishwasher",
  });
  if (!type) throw new Error("no endpoint type");
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `dishwasher-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "dishwasher" });
  await aggregator.add(endpoint);

  let out = { state: -1, error: -1 };
  await endpoint.act((agent) => {
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    const a = agent as any;
    out = {
      state: Number(a.operationalState.state.operationalState),
      error: Number(a.operationalState.state.operationalError.errorStateId),
    };
  });
  return out;
}

const Op = OperationalState.OperationalStateEnum;

describe("dishwasher operational state from real integrations (#486)", () => {
  // The two Home Connect states users care about, both Stopped before.
  it("maps Home Connect run to Running", async () => {
    expect((await bringUp("Run")).state).toBe(Op.Running);
  });

  it("maps Home Connect pause to Paused", async () => {
    expect((await bringUp("Pause")).state).toBe(Op.Paused);
  });

  it("reaches the Error state it declares, with an error to go with it", async () => {
    const out = await bringUp("Error");
    expect(out.state).toBe(Op.Error);
    expect(out.error).toBe(
      OperationalState.ErrorState.UnableToCompleteOperation,
    );
  });

  it("treats a machine waiting for the user as paused", async () => {
    expect((await bringUp("ActionRequired")).state).toBe(Op.Paused);
  });

  it("keeps the idle Home Connect states stopped", async () => {
    for (const s of ["Inactive", "Ready", "DelayedStart", "Finished"]) {
      const out = await bringUp(s);
      expect(out.state, s).toBe(Op.Stopped);
      expect(out.error, s).toBe(OperationalState.ErrorState.NoError);
    }
  });

  it("still understands the plain switch words", async () => {
    expect((await bringUp("on")).state).toBe(Op.Running);
    expect((await bringUp("off")).state).toBe(Op.Stopped);
    expect((await bringUp("paused")).state).toBe(Op.Paused);
  });

  it("understands SmartThings stop", async () => {
    expect((await bringUp("stop")).state).toBe(Op.Stopped);
  });
});
