import { Diagnostic, Logger } from "@matter/general";
import { afterEach, describe, expect, it } from "vitest";
import { logBuffer } from "../../api/logs-api.js";
import {
  categoryFor,
  LoggerService,
  MATTER_TRAFFIC_FACILITIES,
  maskSecrets,
} from "./logger.js";

describe("categoryFor", () => {
  it("tags traffic facilities as matter-traffic", () => {
    for (const facility of MATTER_TRAFFIC_FACILITIES) {
      expect(categoryFor(facility)).toBe("matter-traffic");
    }
  });

  it("returns undefined for HAMH-internal facilities", () => {
    expect(categoryFor("EntityEndpoint")).toBeUndefined();
    expect(categoryFor("BridgeEndpointManager")).toBeUndefined();
    expect(categoryFor("WebApi / Access Log")).toBeUndefined();
  });

  it("returns undefined for unknown matter.js facilities", () => {
    expect(categoryFor("BTP")).toBeUndefined();
    expect(categoryFor("Crypto")).toBeUndefined();
    expect(categoryFor("NetworkInterface")).toBeUndefined();
  });

  it("is case-sensitive (matter.js facility names are stable)", () => {
    expect(categoryFor("interactionserver")).toBeUndefined();
    expect(categoryFor("InteractionServer")).toBe("matter-traffic");
  });
});

describe("MATTER_TRAFFIC_FACILITIES", () => {
  it("covers the documented controller-traffic facilities", () => {
    expect(MATTER_TRAFFIC_FACILITIES.has("InteractionServer")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("MessageExchange")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("MessageChannel")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("ServerSubscription")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("InteractionMessenger")).toBe(true);
    expect(MATTER_TRAFFIC_FACILITIES.has("ExchangeManager")).toBe(true);
  });

  it("surfaces rejected invokes in the traffic category (#423)", () => {
    // UnsupportedEndpoint rejections log under this facility; dropping it
    // hides a controller aiming at a stale endpoint number.
    expect(categoryFor("CommandInvokeResponse")).toBe("matter-traffic");
  });

  it("surfaces session establishment (#477, #478)", () => {
    expect(categoryFor("CaseServer")).toBe("matter-traffic");
    expect(categoryFor("PaseServer")).toBe("matter-traffic");
    expect(categoryFor("FailsafeContext")).toBe("matter-traffic");
  });

  it("surfaces camera plugin logs (#539)", () => {
    expect(categoryFor("CameraPlugin")).toBe("matter-traffic");
    expect(categoryFor("CameraWebRtc")).toBe("matter-traffic");
    expect(categoryFor("CameraWebRtcRequestor")).toBe("matter-traffic");
  });

  it("keeps the passcode-carrying Commissioning facility out", () => {
    expect(categoryFor("Commissioning")).toBeUndefined();
  });
});

describe("maskSecrets", () => {
  const lines = [
    "ProtocolService Invoke « node.aggregator.lock.doorLock.unlockDoor @1:98c06065 pinCode: 32353830",
    "ProtocolService Invoke « node.aggregator.lock.doorLock.setCredential @1:98c06065 operationType: 0 credential: { credentialType: 1, credentialIndex: 2 } credentialData: 39313337",
    "ProtocolService Invoke « node.groupKeyManagement.keySetWrite @0 groupKeySet: { groupKeySetId: 7, groupKeySecurityPolicy: 0, epochKey0: a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1, epochStartTime0: 1700000000000000, epochKey1: b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2, epochStartTime1: 1, epochKey2: c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3, epochStartTime2: 2 }",
    "ProtocolService Invoke « node.operationalCredentials.addNoc @0:0 nocValue: 1530010102 icacValue:  ipkValue: 1ca8361b03bbba498945b99f00112233 caseAdminSubject: 15478857231067401254 adminVendorId: 65521",
    "ProtocolService Invoke « node.administratorCommissioning.openCommissioningWindow @1:98c06065 commissioningTimeout: 180 pakePasscodeVerifier: b96170aa907c5e3d0f1e2a4b6c8d9e0f04a1b2c3d4e5f60718293a4b5c6d7e8f9a discriminator: 3840 iterations: 1000 salt: 5350414b453250204b65792053616c74",
  ];

  it("masks exactly the secret fields in plain lines", () => {
    expect(lines.map(maskSecrets)).toEqual([
      "ProtocolService Invoke « node.aggregator.lock.doorLock.unlockDoor @1:98c06065 pinCode: [redacted]",
      "ProtocolService Invoke « node.aggregator.lock.doorLock.setCredential @1:98c06065 operationType: 0 credential: { credentialType: 1, credentialIndex: 2 } credentialData: [redacted]",
      "ProtocolService Invoke « node.groupKeyManagement.keySetWrite @0 groupKeySet: { groupKeySetId: 7, groupKeySecurityPolicy: 0, epochKey0: [redacted], epochStartTime0: 1700000000000000, epochKey1: [redacted], epochStartTime1: 1, epochKey2: [redacted], epochStartTime2: 2 }",
      "ProtocolService Invoke « node.operationalCredentials.addNoc @0:0 nocValue: 1530010102 icacValue:  ipkValue: [redacted] caseAdminSubject: 15478857231067401254 adminVendorId: 65521",
      "ProtocolService Invoke « node.administratorCommissioning.openCommissioningWindow @1:98c06065 commissioningTimeout: 180 pakePasscodeVerifier: [redacted] discriminator: 3840 iterations: 1000 salt: 5350414b453250204b65792053616c74",
    ]);
  });

  it("returns other lines unchanged", () => {
    const line =
      "Invoke « x errorCode: 0 statusCode: 1 countryCode: 4445 Manual pairing code: 34970112332";
    expect(maskSecrets(line)).toBe(line);
  });
});

describe("LoggerService secret masking", () => {
  const original = {
    level: Logger.level,
    format: Logger.format,
    write: Logger.destinations.default.write,
  };
  afterEach(() => {
    delete Logger.destinations["hamh-buffer"];
    Logger.destinations.default.write = original.write;
    Logger.level = original.level;
    Logger.format = original.format;
    for (const f of ["MessageChannel", "MessageExchange"]) {
      delete Logger.facilityLevels[f];
    }
    logBuffer.entries.length = 0;
  });

  function invoke(facility: string) {
    Logger.get(facility).info(
      "Invoke",
      "«",
      "x",
      Diagnostic.dict({
        pinCode: new Uint8Array([0x32, 0x35, 0x38, 0x30]),
        credentialData: new Uint8Array([0x39, 0x31, 0x33, 0x37]),
        ipkValue: new Uint8Array([0x1c, 0xa8, 0x36, 0x1b]),
        pakePasscodeVerifier: new Uint8Array([0xb9, 0x61, 0x70, 0xaa]),
        salt: new Uint8Array([0x53, 0x50, 0x41, 0x4b]),
        icacValue: new Uint8Array(0),
        errorCode: 0,
      }),
    );
  }

  for (const disableColors of [true, false]) {
    it(`masks console and buffer lines (${disableColors ? "plain" : "ansi"})`, () => {
      const console: string[] = [];
      Logger.destinations.default.write = (text) => console.push(text);
      new LoggerService({ level: "info", disableColors });
      invoke("ProtocolService");
      invoke("InteractionServer");
      const buffered = logBuffer.entries.map((e) => e.message);
      expect(console).toHaveLength(2);
      expect(buffered).toHaveLength(1);
      for (const text of [...console, ...buffered]) {
        expect(text).not.toMatch(/32353830|39313337|1ca8361b|b96170aa/);
        expect(text.match(/\[redacted\]/g)).toHaveLength(4);
        expect(text).toContain("5350414b");
        expect(text).toContain("icacValue:");
        expect(text).toContain("errorCode: ");
        if (!disableColors) expect(text).toContain("\x1b[34mpinCode: ");
      }
    });
  }

  it("does not stack wrappers on a second construction", () => {
    new LoggerService({ level: "info", disableColors: true });
    const wrapped = Logger.destinations.default.write;
    new LoggerService({ level: "info", disableColors: true });
    expect(Logger.destinations.default.write).toBe(wrapped);
  });
});
