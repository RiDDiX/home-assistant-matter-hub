import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, VariableService } from "@matter/general";
import { Endpoint, VendorId } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";

// #404: renaming an HA entity recreates the endpoint with the same id. If the
// old endpoint is delete()d its persisted number is erased, so the recreated
// endpoint gets a fresh number and controllers (Alexa) treat it as a new
// device. close() keeps the number pre-allocated so the same-id recreate
// reuses it.

let dir: string;
let env: Environment;
let server: ServerNode | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-404-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
});

afterEach(async () => {
  // Close in afterEach so a failed assertion still frees the server handles.
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function makeServer(): Promise<AggregatorEndpoint> {
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: "hamh-404-node",
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  return aggregator;
}

function plug(): Endpoint {
  return new Endpoint(OnOffPlugInUnitDevice, { id: "x" });
}

describe("endpoint number preservation on same-id recreate (#404)", () => {
  it("close() keeps the number: same-id recreate reuses it, no collision", async () => {
    const aggregator = await makeServer();

    const first = plug();
    await aggregator.add(first);
    const firstNumber = first.number;
    expect(firstNumber).toBeGreaterThan(0);

    // close() deactivates the store (number kept pre-allocated) and the
    // destroyed lifecycle hook auto-removes it from aggregator.parts.
    await first.close();
    expect(aggregator.parts.has("x")).toBe(false);

    const second = plug();
    await aggregator.add(second);
    expect(second.number).toBe(firstNumber);
  });

  it("delete() erases the number: same-id recreate gets a fresh number", async () => {
    const aggregator = await makeServer();

    const first = plug();
    await aggregator.add(first);
    const firstNumber = first.number;
    expect(firstNumber).toBeGreaterThan(0);

    await first.delete();
    expect(aggregator.parts.has("x")).toBe(false);

    const second = plug();
    await aggregator.add(second);
    expect(second.number).not.toBe(firstNumber);
  });
});
