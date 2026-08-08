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
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { InputSelectDevice, SelectDevice } from "./index.js";

// #356: controllers can't render ModeSelect, so a select can opt into a
// plain on/off switch whose on/off each pick a configured option.

const PLUG = 0x010a;

let dir: string;
let env: Environment;
let calls: HomeAssistantAction[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-sel-356-"));
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function selectEntity(
  entityId: string,
  state: string,
): HomeAssistantEntityInformation {
  const s = {
    entity_id: entityId,
    state,
    attributes: {
      friendly_name: "Persianas",
      options: ["Subidas", "Casa", "Neutral", "Bajadas"],
    },
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
  // biome-ignore lint/suspicious/noExplicitAny: test fixture
  return { entity_id: entityId, state: s as any };
}

function mappingFor(entityId: string): EntityMappingConfig {
  return {
    entityId,
    selectExposeAsSwitch: true,
    selectSwitchOnOption: "Casa",
    selectSwitchOffOption: "Neutral",
  };
}

// Distinct entity ids per test, the optimistic onOff map is per entity id.
async function mount(
  entityId: string,
  state: string,
  device: typeof InputSelectDevice = InputSelectDevice,
) {
  const server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "sel-356-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  const type = device({
    entity: selectEntity(entityId, state),
    mapping: mappingFor(entityId),
  } as never);
  if (!type) {
    throw new Error("no endpoint type");
  }
  const endpoint = new Endpoint(type, { id: "sel" });
  await aggregator.add(endpoint);
  return { server, endpoint };
}

describe("select exposed as switch (#356)", () => {
  it("exposes a plug device whose on/off pick the configured options", async () => {
    const { server, endpoint } = await mount(
      "input_select.persianas_a",
      "Neutral",
    );
    let types: number[] = [];
    let onOff: boolean | undefined;
    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      const a = agent as any;
      types = (
        a.descriptor.state.deviceTypeList as Array<{ deviceType: number }>
      ).map((d) => Number(d.deviceType));
      onOff = a.onOff.state.onOff;
      a.onOff.on();
      a.onOff.off();
    });
    await server.close().catch(() => {});

    expect(types).toContain(PLUG);
    expect(onOff).toBe(false); // state Neutral = off option
    const options = calls
      .filter((c) => c.action === "input_select.select_option")
      .map((c) => (c.data as { option?: string }).option);
    expect(options).toEqual(["Casa", "Neutral"]);
  });

  it("reports on when the entity state matches the on option", async () => {
    const { server, endpoint } = await mount(
      "input_select.persianas_b",
      "casa", // different casing on purpose
    );
    let onOff: boolean | undefined;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: read state
      onOff = (agent as any).onOff.state.onOff;
    });
    await server.close().catch(() => {});
    expect(onOff).toBe(true);
  });

  it("uses select.select_option for the select domain", async () => {
    const { server, endpoint } = await mount(
      "select.persianas_c",
      "Neutral",
      SelectDevice,
    );
    calls.length = 0;
    await endpoint.act((agent) => {
      // biome-ignore lint/suspicious/noExplicitAny: drive the cluster
      (agent as any).onOff.on();
    });
    await server.close().catch(() => {});
    const call = calls.find((c) => c.action === "select.select_option");
    expect((call?.data as { option?: string }).option).toBe("Casa");
  });
});
