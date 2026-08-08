import { describe, expect, it } from "vitest";
import {
  alexaPairingPortProblem,
  classifyController,
  computeControllerWarnings,
  controllerWarningsForFabrics,
} from "./controller-compat.js";

describe("classifyController", () => {
  it("maps the known controller vendor ids", () => {
    expect(classifyController(4937)).toBe("apple"); // 0x1349
    expect(classifyController(24582)).toBe("google"); // 0x6006
    expect(classifyController(4631)).toBe("alexa"); // 0x1217
    expect(classifyController(4447)).toBe("aqara"); // 0x115F
  });

  it("returns undefined for non-controller vendors (HA hub, SmartThings, unknown)", () => {
    expect(classifyController(4939)).toBeUndefined(); // Home Assistant
    expect(classifyController(4362)).toBeUndefined(); // SmartThings
    expect(classifyController(99999)).toBeUndefined();
  });
});

describe("alexaPairingPortProblem", () => {
  it("flags an Alexa vendor pairing on a non-5540 port", () => {
    expect(alexaPairingPortProblem(4631, 5541)).toBe(true); // 0x1217
    expect(alexaPairingPortProblem(4448, 5542)).toBe(true); // 0x1160
  });

  it("does not flag Alexa on port 5540", () => {
    expect(alexaPairingPortProblem(4631, 5540)).toBe(false);
  });

  it("does not flag other controllers on any port", () => {
    expect(alexaPairingPortProblem(24582, 5541)).toBe(false); // Google
    expect(alexaPairingPortProblem(99999, 5541)).toBe(false); // unknown
  });
});

describe("computeControllerWarnings", () => {
  it("warns when a commissioned controller does not support an exposed type", () => {
    // 0x002b (fan) is not supported on Apple Home
    const warnings = computeControllerWarnings(
      ["apple"],
      [{ entityId: "fan.office", deviceTypeId: 0x2b }],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      entityId: "fan.office",
      controller: "apple",
      controllerLabel: "Apple Home",
    });
  });

  it("does not warn when the type is supported (fan on Google/Alexa)", () => {
    expect(
      computeControllerWarnings(
        ["google", "alexa"],
        [{ entityId: "fan.office", deviceTypeId: 0x2b }],
      ),
    ).toEqual([]);
  });

  it("does not warn for Aqara on types it supports that others reject", () => {
    // Aqara Home surfaces fans (0x002b), speakers (0x0022) and the newer
    // leak/rain detectors (0x0044) that Apple/Google/Alexa reject.
    expect(
      computeControllerWarnings(
        ["aqara"],
        [
          { entityId: "fan.office", deviceTypeId: 0x2b },
          { entityId: "media_player.kitchen", deviceTypeId: 0x22 },
          { entityId: "binary_sensor.leak", deviceTypeId: 0x44 },
        ],
      ),
    ).toEqual([]);
  });

  it("does not warn on partial or unknown, only on a hard no", () => {
    // generic switch (0x000f) is partial on Apple, no on Google
    const apple = computeControllerWarnings(
      ["apple"],
      [{ entityId: "event.btn", deviceTypeId: 0xf }],
    );
    expect(apple).toEqual([]);
    const google = computeControllerWarnings(
      ["google"],
      [{ entityId: "event.btn", deviceTypeId: 0xf }],
    );
    expect(google).toHaveLength(1);
  });

  it("ignores device types with no support data and supported core types", () => {
    expect(
      computeControllerWarnings(
        ["apple", "google", "alexa"],
        [
          { entityId: "light.kitchen", deviceTypeId: 0x100 }, // supported everywhere
          { entityId: "x.unknown", deviceTypeId: 0x9999 }, // not in the table
        ],
      ),
    ).toEqual([]);
  });

  it("flags the #365 detector types on every controller", () => {
    const warnings = computeControllerWarnings(
      ["apple", "google", "alexa"],
      [{ entityId: "binary_sensor.rain", deviceTypeId: 0x44 }],
    );
    // rain is no on all three
    expect(warnings.map((w) => w.controller).sort()).toEqual([
      "alexa",
      "apple",
      "google",
    ]);
    expect(warnings[0].note).toContain("#365");
  });
});

describe("energy device type support", () => {
  it("solar power (0x0017) no longer counts as supported on Google", () => {
    // id 23 google was corrected off "yes": a hard "no" must now warn.
    const warnings = computeControllerWarnings(
      ["google"],
      [{ entityId: "sensor.pv", deviceTypeId: 0x17 }],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].note).toContain("SolarPower");
  });

  it("electrical meter (0x0514) warns on Apple and Alexa but not Google", () => {
    // id 1300: apple/alexa no, google yes, aqara unknown.
    const warnings = computeControllerWarnings(
      ["apple", "google", "alexa", "aqara"],
      [{ entityId: "sensor.meter", deviceTypeId: 0x514 }],
    );
    expect(warnings.map((w) => w.controller).sort()).toEqual([
      "alexa",
      "apple",
    ]);
    expect(warnings[0].note).toContain("ElectricalMeter");
  });

  it("battery storage (0x0018) warns everywhere except Aqara", () => {
    // id 24: apple/google/alexa no, aqara yes.
    const warnings = computeControllerWarnings(
      ["apple", "google", "alexa", "aqara"],
      [{ entityId: "sensor.battery", deviceTypeId: 0x18 }],
    );
    expect(warnings.map((w) => w.controller).sort()).toEqual([
      "alexa",
      "apple",
      "google",
    ]);
  });

  it("energy evse (0x050C) warns everywhere except Aqara", () => {
    // id 1292: apple/google/alexa no, aqara yes.
    const warnings = computeControllerWarnings(
      ["apple", "google", "alexa", "aqara"],
      [{ entityId: "sensor.wallbox", deviceTypeId: 0x50c }],
    );
    expect(warnings.map((w) => w.controller).sort()).toEqual([
      "alexa",
      "apple",
      "google",
    ]);
    expect(warnings[0].note).toContain("Alexa");
  });
});

describe("controllerWarningsForFabrics", () => {
  it("derives warnings from a fabric's root vendor id", () => {
    const warnings = controllerWarningsForFabrics(
      [{ rootVendorId: 4937 }], // 0x1349 Apple Home
      [{ entityId: "fan.office", deviceTypeId: 0x2b }], // fan: no on Apple
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      entityId: "fan.office",
      controller: "apple",
    });
  });

  it("warns once for two fabrics of the same ecosystem", () => {
    const warnings = controllerWarningsForFabrics(
      [{ rootVendorId: 4937 }, { rootVendorId: 4996 }], // both Apple
      [{ entityId: "fan.office", deviceTypeId: 0x2b }],
    );
    expect(warnings).toHaveLength(1);
  });

  it("stays silent when no fabric maps to a known controller", () => {
    expect(
      controllerWarningsForFabrics(
        [{ rootVendorId: 4939 }], // Home Assistant hub
        [{ entityId: "fan.office", deviceTypeId: 0x2b }],
      ),
    ).toEqual([]);
  });
});
