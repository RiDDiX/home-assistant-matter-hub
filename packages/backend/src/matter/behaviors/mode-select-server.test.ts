import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { HomeAssistantActions } from "../../services/home-assistant/home-assistant-actions.js";
import { AggregatorEndpoint } from "../endpoints/aggregator-endpoint.js";
import { createLegacyEndpointType } from "../endpoints/legacy/create-legacy-endpoint-type.js";
import { buildSupportedModes, findCurrentMode } from "./mode-select-server.js";
import { clampCurrentMode } from "./utils/clamp-current-mode.js";

describe("buildSupportedModes", () => {
  it("keeps mode labels stable for runtime option updates", () => {
    expect(buildSupportedModes(["Home", "Night"])).toEqual([
      { label: "Home", mode: 0, semanticTags: [] },
      { label: "Night", mode: 1, semanticTags: [] },
    ]);
  });

  it("truncates labels to the Matter string limit", () => {
    expect(buildSupportedModes(["a".repeat(100)])[0].label).toBe(
      "a".repeat(64),
    );
  });

  it("cuts labels by UTF-8 bytes", () => {
    const label = buildSupportedModes(["\u5ba2".repeat(40)])[0].label;
    expect(label).toBe("\u5ba2".repeat(21));
  });

  it("caps the list at 255 modes and falls back for options beyond it", () => {
    const options = Array.from({ length: 300 }, (_, i) => `Option ${i}`);
    const modes = buildSupportedModes(options);
    expect(modes).toHaveLength(255);
    expect(modes[254]).toMatchObject({ label: "Option 254", mode: 254 });
    expect(findCurrentMode(options, "option 254")).toBe(254);
    expect(findCurrentMode(options, "Option 299")).toBe(0);
    expect(findCurrentMode(options, undefined)).toBe(0);
  });
});

describe("clampCurrentMode", () => {
  const supportedModes = [{ mode: 0 }, { mode: 1 }, { mode: 2 }];

  it("replaces a mode that left the list", () => {
    const state = { supportedModes, currentMode: 5 };
    clampCurrentMode(state, 0);
    expect(state.currentMode).toBe(0);
  });

  it("keeps a mode that is still listed", () => {
    const state = { supportedModes, currentMode: 2 };
    clampCurrentMode(state, 0);
    expect(state.currentMode).toBe(2);
  });
});

describe("stored currentMode after the options shrink", () => {
  it("restarts with the stored mode gone instead of failing the endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hamh-mode-select-"));
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", dir);
    env.set(HomeAssistantActions, {
      call() {},
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any);
    env.set(
      BridgeDataProvider,
      new BridgeDataProvider({
        id: "b",
        name: "b",
        port: 0,
        filter: { include: [], exclude: [], includeMode: "any" },
        featureFlags: {},
        basicInformation: {
          vendorId: 0xfff1,
          vendorName: "riddix",
          productName: "MatterHub",
          productLabel: "Home Assistant Matter Hub",
          hardwareVersion: 1,
          softwareVersion: 1,
          // biome-ignore lint/suspicious/noExplicitAny: test fixture
        } as any,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
      } as any),
    );
    let server: ServerNode | undefined;

    async function start(options: string[], state: string) {
      const entity = {
        entity_id: "select.mode",
        state: { entity_id: "select.mode", state, attributes: { options } },
      };
      const type = createLegacyEndpointType(entity as never, {
        entityId: "select.mode",
      })!;
      server = await ServerNode.create({
        // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
        environment: env as any,
        id: "mode-select-node",
        network: { port: 0 },
        commissioning: { passcode: 20202021, discriminator: 3840 },
        basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
      });
      const aggregator = new AggregatorEndpoint("aggregator");
      await server.add(aggregator);
      const endpoint = new Endpoint(type, { id: "s" });
      await aggregator.add(endpoint);
      return endpoint;
    }

    try {
      const first = await start(["a", "b", "c", "d", "e", "f"], "a");
      // A seeded value is not stored, a runtime change is
      await first.set({ modeSelect: { currentMode: 5 } });
      await server?.close();

      const second = await start(["a", "b", "c"], "b");
      // biome-ignore lint/suspicious/noExplicitAny: read cluster state
      expect((second.state as any).modeSelect.currentMode).toBe(1);
    } finally {
      await server?.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
