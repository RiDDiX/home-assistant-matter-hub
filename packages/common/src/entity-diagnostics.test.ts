import { describe, expect, it } from "vitest";
import type { FailedEntity } from "./bridge-data.js";
import type {
  ControllerWarning,
  ExposedDeviceType,
} from "./controller-compat.js";
import { buildEntityDiagnostics } from "./entity-diagnostics.js";

const exposed: ExposedDeviceType[] = [
  { entityId: "light.kitchen", deviceTypeId: 0x100 },
  { entityId: "fan.office", deviceTypeId: 0x2b },
];

describe("buildEntityDiagnostics", () => {
  it("marks a failed entity with its reason", () => {
    const failed: FailedEntity[] = [
      { entityId: "climate.ac", reason: "Behaviors have errors" },
    ];
    const d = buildEntityDiagnostics([], failed, []);
    expect(d).toEqual([
      {
        entityId: "climate.ac",
        status: "failed",
        reason: "Behaviors have errors",
      },
    ]);
  });

  it("carries failedAt through to the failed diagnostic", () => {
    const failed: FailedEntity[] = [
      {
        entityId: "climate.ac",
        reason: "Behaviors have errors",
        failedAt: "2026-06-17T10:00:00Z",
      },
    ];
    const d = buildEntityDiagnostics([], failed, []);
    expect(d[0]).toMatchObject({
      entityId: "climate.ac",
      status: "failed",
      failedAt: "2026-06-17T10:00:00Z",
    });
  });

  it("marks an exposed entity with a controller warning as limited", () => {
    const warnings: ControllerWarning[] = [
      {
        entityId: "fan.office",
        deviceTypeId: 0x2b,
        controller: "apple",
        controllerLabel: "Apple Home",
        note: "Apple Home has no standalone fan.",
      },
    ];
    const d = buildEntityDiagnostics(exposed, [], warnings);
    const fan = d.find((x) => x.entityId === "fan.office");
    expect(fan).toMatchObject({
      status: "limited",
      deviceTypeId: 0x2b,
      unsupportedBy: [{ controller: "apple", controllerLabel: "Apple Home" }],
    });
  });

  it("marks an exposed entity with no warning as ok", () => {
    const d = buildEntityDiagnostics(exposed, [], []);
    expect(d.find((x) => x.entityId === "light.kitchen")?.status).toBe("ok");
  });

  it("reports a failed entity once, not also as exposed", () => {
    const failed: FailedEntity[] = [
      { entityId: "light.kitchen", reason: "init error" },
    ];
    const d = buildEntityDiagnostics(exposed, failed, []);
    const kitchen = d.filter((x) => x.entityId === "light.kitchen");
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0].status).toBe("failed");
  });
});
