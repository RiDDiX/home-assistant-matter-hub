import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import { createCameraEndpointType } from "../../plugins/builtin/camera/camera-endpoint.js";
import { WebRtcBridge } from "../../plugins/builtin/camera/webrtc-bridge.js";
import { endpointToJson } from "./endpoint-to-json.js";

// #155: the camera state holds the WebRtcBridge, the devices API printed its token

let dir: string;
let env: Environment;
let server: ServerNode | undefined;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-endpoint-json-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});

afterEach(async () => {
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(type: unknown): Promise<ServerNode> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `endpoint-json-node-${counter++}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(new Endpoint(type as never, { id: "camera" }));
  return server;
}

describe("endpointToJson", () => {
  it("keeps the camera bridge credentials out of the devices JSON", async () => {
    const bridge = new WebRtcBridge({
      haUrl: "http://supervisor/core",
      haToken: "super-secret-token",
    });
    const node = await mount(createCameraEndpointType(bridge, "camera.front"));

    const json = JSON.stringify(endpointToJson(node));

    expect(json).not.toContain("super-secret-token");
    expect(json).not.toContain("http://supervisor/core");
    // nothing enumerable on the bridge, a later connection cannot leak either
    expect(json).toContain('"bridge":{}');
    await bridge.close();
  });

  it("redacts state keys that look like credentials", async () => {
    const fake = {
      haToken: "leaky",
      snapshot: async () => new Uint8Array(0),
    } as unknown as WebRtcBridge;
    const node = await mount(createCameraEndpointType(fake, "camera.side"));

    const json = JSON.stringify(endpointToJson(node));

    expect(json).not.toContain("leaky");
    expect(json).toContain("[redacted]");
  });
});
