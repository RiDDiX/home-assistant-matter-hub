import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, type EndpointType, VendorId } from "@matter/main";
import { EnergyEvseModeServer } from "@matter/main/behaviors";
import { EnergyEvseMode } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../../services/bridges/bridge-data-provider.js";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../../services/home-assistant/home-assistant-config.js";
import { AggregatorEndpoint } from "../../../aggregator-endpoint.js";
import { createLegacyEndpointType } from "../../create-legacy-endpoint-type.js";

// #475: SmartThings picks EnergyEvseMode modes by list position, so Manual is
// mode 0. A persisted currentMode from before must still mount.

const EVSE = "sensor.wallbox_status";

let dir: string;
let env: Environment;
let server: ServerNode | undefined;

function makeEnv(): Environment {
  const e = new Environment("test", Environment.default);
  e.get(VariableService).set("storage.path", dir);
  e.set(HomeAssistantActions, {
    call() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  e.set(
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
  e.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  e.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  return e;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-evse-475-"));
  env = makeEnv();
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function statusEntity(): HomeAssistantEntityInformation {
  const state = {
    entity_id: EVSE,
    state: "idle",
    attributes: { friendly_name: EVSE },
    context: { id: "c" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: EVSE, state: state as any };
}

// Same node id so every mount shares the storage.
const NODE_ID = "evse-475-node";

async function closeServer() {
  await server?.close().catch(() => {});
  server = undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: agent typed loosely for the test
async function mount(type: EndpointType): Promise<Endpoint<any>> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: NODE_ID,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const endpoint = new Endpoint(type, { id: "evse" });
  await aggregator.add(endpoint);
  return endpoint;
}

function evseType() {
  const type = createLegacyEndpointType(statusEntity(), {
    entityId: EVSE,
    matterDeviceType: "evse",
  });
  if (!type) throw new Error("no endpoint type");
  return type;
}

// biome-ignore lint/suspicious/noExplicitAny: read cluster state
async function currentMode(endpoint: Endpoint<any>): Promise<number> {
  return endpoint.act((agent) =>
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    Number((agent as any).energyEvseMode.state.currentMode),
  );
}

describe("evse mode numbering (#475)", () => {
  it("accepts a ChangeToMode for position 0 and refuses 1", async () => {
    const endpoint = await mount(evseType());
    await endpoint.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      await (agent as any).energyEvseMode.changeToMode({ newMode: 0 });
    });
    expect(await currentMode(endpoint)).toBe(0);

    const answer = await endpoint.act((agent) =>
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).energyEvseMode.changeToMode({ newMode: 1 }),
    );
    expect(Number(answer.status)).not.toBe(0);
    expect(await currentMode(endpoint)).toBe(0);
  });

  it("mounts over storage that still holds a mode from before the renumbering", async () => {
    // Old numbering plus a second mode, so a mode change gets written.
    const OldModes = EnergyEvseModeServer.set({
      supportedModes: [
        {
          label: "Manual",
          mode: 1,
          modeTags: [{ value: EnergyEvseMode.ModeTag.Manual }],
        },
        {
          label: "Other",
          mode: 2,
          modeTags: [{ value: EnergyEvseMode.ModeTag.Manual }],
        },
      ],
      currentMode: 1,
    });
    // Real type, only the mode server swapped.
    // biome-ignore lint/suspicious/noExplicitAny: swap one behavior on the built type
    const oldType = (evseType() as any).with(OldModes) as EndpointType;
    const first = await mount(oldType);
    await first.act(async (agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      await (agent as any).energyEvseMode.changeToMode({ newMode: 2 });
    });
    expect(await currentMode(first)).toBe(2);
    await closeServer();

    // Same storage, old shape: the written mode survived.
    env = makeEnv();
    const second = await mount(oldType);
    expect(await currentMode(second)).toBe(2);
    await closeServer();

    // Same storage, current shape: 2 is gone, land on 0.
    env = makeEnv();
    const endpoint = await mount(evseType());
    expect(await currentMode(endpoint)).toBe(0);
  });
});
