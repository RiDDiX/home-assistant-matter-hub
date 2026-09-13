import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { OperationalCredentialsServer } from "@matter/main/behaviors";
import { ServerNode } from "@matter/main/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeServerConfig } from "../utils/json/create-bridge-server-config.js";
import {
  AttestationWarningServer,
  CSR_GRACE_MS,
  csrArrived,
  watchForCsr,
} from "./attestation-warning.js";
import { rootEndpointType } from "./tc-general-commissioning.js";

// #465: a controller that does not trust the matter.js development attestation
// aborts right after AttestationRequest and never sends CSRRequest. Nothing in
// the log said so, the user only saw "Failed".

describe("attestation abort watch (#465)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns when no CSRRequest follows the attestation", () => {
    const onMissing = vi.fn();
    watchForCsr("bridge-1", onMissing);
    vi.advanceTimersByTime(CSR_GRACE_MS);
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when commissioning continues", () => {
    const onMissing = vi.fn();
    watchForCsr("bridge-1", onMissing);
    csrArrived("bridge-1");
    vi.advanceTimersByTime(CSR_GRACE_MS * 2);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("warns once when a controller retries the attestation", () => {
    const onMissing = vi.fn();
    watchForCsr("bridge-1", onMissing);
    vi.advanceTimersByTime(CSR_GRACE_MS / 2);
    watchForCsr("bridge-1", onMissing);
    vi.advanceTimersByTime(CSR_GRACE_MS);
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("keeps two controllers on one bridge apart", () => {
    const first = vi.fn();
    const second = vi.fn();
    watchForCsr("bridge-1:100", first);
    watchForCsr("bridge-1:200", second);
    csrArrived("bridge-1:200");
    vi.advanceTimersByTime(CSR_GRACE_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps bridges apart", () => {
    const first = vi.fn();
    const second = vi.fn();
    watchForCsr("bridge-1", first);
    watchForCsr("bridge-2", second);
    csrArrived("bridge-1");
    vi.advanceTimersByTime(CSR_GRACE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("root endpoint composition (#465)", () => {
  let dir: string;
  let server: ServerNode | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hamh-465-"));
  });

  afterEach(async () => {
    await server?.close().catch(() => {});
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function bridgeData(flags: Record<string, unknown>): BridgeData {
    return {
      id: `att465-${JSON.stringify(flags).length}`,
      name: "b",
      port: 0,
      filter: { include: [], exclude: [], includeMode: "any" },
      featureFlags: flags,
      basicInformation: {
        vendorId: 0xfff1,
        vendorName: "t",
        productId: 0x8000,
        productName: "t",
        productLabel: "t",
        hardwareVersion: 1,
        softwareVersion: 1,
      },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any;
  }

  it("mounts the watch with and without the terms flag", () => {
    expect(rootEndpointType({}).behaviors.operationalCredentials).toBe(
      AttestationWarningServer,
    );
    const withTerms = rootEndpointType({ supportTermsAndConditions: true });
    expect(withTerms.behaviors.operationalCredentials).toBe(
      AttestationWarningServer,
    );
    expect(withTerms.behaviors.generalCommissioning).not.toBe(
      rootEndpointType({}).behaviors.generalCommissioning,
    );
  });

  // The two override bodies cannot be driven offline, both matter.js
  // implementations assert a remote actor, so the wiring is pinned instead.
  it("overrides both commissioning steps", () => {
    expect(AttestationWarningServer.prototype.attestationRequest).not.toBe(
      OperationalCredentialsServer.prototype.attestationRequest,
    );
    expect(AttestationWarningServer.prototype.csrRequest).not.toBe(
      OperationalCredentialsServer.prototype.csrRequest,
    );
  });

  async function mount(opts?: {
    stock?: boolean;
    store?: string;
    id?: string;
  }) {
    const env = new Environment("test", Environment.default);
    env.get(VariableService).set("storage.path", join(dir, opts?.store ?? "a"));
    const config = createBridgeServerConfig(bridgeData({}));
    return ServerNode.create({
      ...config,
      ...(opts?.stock ? { type: ServerNode.RootEndpoint } : {}),
      ...(opts?.id ? { id: opts.id } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      network: { ...config.network, port: 0 },
      commissioning: { passcode: 20202021, discriminator: 3840 },
    });
  }

  it("still builds a working node", async () => {
    server = await mount();
    expect(server.state.operationalCredentials.supportedFabrics).toBe(254);
  });

  // The watch must stay invisible to controllers, an added attribute or command
  // would change the fingerprint of every bridge that is already paired (#456).
  it("leaves the operational credentials cluster unchanged", async () => {
    server = await mount();
    const stock = await mount({ stock: true, store: "b", id: "stock" });
    try {
      const shape = (node: ServerNode) => {
        // biome-ignore lint/suspicious/noExplicitAny: read cluster metadata
        const state = node.state as any;
        const s = state.operationalCredentials;
        return {
          attributeList: s.attributeList,
          acceptedCommandList: s.acceptedCommandList,
          generatedCommandList: s.generatedCommandList,
          clusterRevision: s.clusterRevision,
          featureMap: s.featureMap,
          // the root cluster list is the fingerprint a controller stores
          serverList: state.descriptor.serverList,
          deviceTypeList: state.descriptor.deviceTypeList,
        };
      };
      expect(shape(server).attributeList.length).toBeGreaterThan(0);
      expect(shape(server).serverList.length).toBeGreaterThan(0);
      expect(shape(server)).toEqual(shape(stock));
    } finally {
      await stock.close().catch(() => {});
    }
  });

  // The upgrade path: storage written before the watch existed has to come back
  // up under the composed root endpoint, or every paired bridge breaks.
  it("reopens storage written without the watch", async () => {
    const before = await mount({ stock: true, store: "c" });
    expect(before.state.operationalCredentials.supportedFabrics).toBe(254);
    await before.close();

    server = await mount({ store: "c" });
    expect(server.state.operationalCredentials.supportedFabrics).toBe(254);
  });
});
