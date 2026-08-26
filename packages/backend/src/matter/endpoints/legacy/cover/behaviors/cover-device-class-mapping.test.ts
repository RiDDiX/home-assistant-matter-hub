import type { HomeAssistantEntityState } from "@home-assistant-matter-hub/common";
import { WindowCovering } from "@matter/main/clusters";
import { describe, expect, it } from "vitest";
import {
  DEVICE_CLASS_TO_MATTER_TYPE,
  deviceClassMapping,
  liftShouldUseTilt,
} from "./cover-window-covering-server.js";

const entity = (
  device_class?: unknown,
  supported_features?: number,
): HomeAssistantEntityState => {
  const attributes: Record<string, unknown> = {};
  if (device_class !== undefined) attributes.device_class = device_class;
  if (supported_features !== undefined)
    attributes.supported_features = supported_features;
  return {
    entity_id: "cover.test",
    state: "open",
    context: { id: "ctx" },
    last_changed: "t",
    last_updated: "t",
    attributes,
  } as unknown as HomeAssistantEntityState;
};

describe("deviceClassMapping", () => {
  it("maps curtain to Drapery + CentralCurtain", () => {
    const mapping = deviceClassMapping(entity("curtain"));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Drapery);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.CentralCurtain,
    );
  });

  it("maps shutter to Shutter + RollerShutter", () => {
    const mapping = deviceClassMapping(entity("shutter"));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Shutter);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.RollerShutter,
    );
  });

  it("maps awning to Awning + AwningTerracePatio", () => {
    const mapping = deviceClassMapping(entity("awning"));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Awning);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.AwningTerracePatio,
    );
  });

  it("is case-insensitive", () => {
    expect(deviceClassMapping(entity("Curtain"))?.type).toBe(
      WindowCovering.WindowCoveringType.Drapery,
    );
  });

  it("returns undefined for missing device_class", () => {
    expect(deviceClassMapping(entity())).toBeUndefined();
  });

  it("returns undefined for unknown device_class", () => {
    expect(deviceClassMapping(entity("spaceship"))).toBeUndefined();
  });

  it("returns undefined for non-string device_class", () => {
    expect(deviceClassMapping(entity(42))).toBeUndefined();
  });

  it("falls back to Rollershade for blind without tilt feature (#312)", () => {
    // supported_features=7 = open + close + set_position (lift only).
    // InteriorBlind needs LF & TL per spec, so the product goes Unknown.
    const mapping = deviceClassMapping(entity("blind", 7));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Rollershade);
    expect(mapping?.endProductType).toBe(WindowCovering.EndProductType.Unknown);
  });

  it("uses Unknown for a window that also tilts", () => {
    const mapping = deviceClassMapping(entity("window", 143));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(WindowCovering.EndProductType.Unknown);
  });

  it("uses TiltBlindLift for blind with both lift and tilt (#323)", () => {
    // supported_features=7+16=23 includes support_open + support_open_tilt
    const mapping = deviceClassMapping(entity("blind", 23));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.InteriorBlind,
    );
  });

  // The endpoint always puts Lift in the feature map, so TiltBlindTiltOnly
  // (conformance !LF & TL) can never be honest here, whatever HA reports.
  it("uses TiltBlindLift for a tilt-only blind, since Lift is advertised anyway", () => {
    // supported_features=16+32+64+128=240 = tilt features only
    const mapping = deviceClassMapping(entity("blind", 240));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.InteriorBlind,
    );
  });

  it("uses TiltBlindLift with a matching product for a curtain that also tilts", () => {
    // Drapery is LF & !TL, and CentralCurtain belongs to Drapery, so both
    // move: the tilting curtain product is the vertical blind strip curtain
    const mapping = deviceClassMapping(entity("curtain", 143));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.VerticalBlindStripCurtain,
    );
  });

  it("uses SheerShade for a shade that also tilts", () => {
    const mapping = deviceClassMapping(entity("shade", 143));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.SheerShade,
    );
  });

  it("falls back to Unknown for a tilting awning", () => {
    // No tilting counterpart exists for awnings, honest beats wrong
    const mapping = deviceClassMapping(entity("awning", 143));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.TiltBlindLift);
    expect(mapping?.endProductType).toBe(WindowCovering.EndProductType.Unknown);
  });

  it("keeps Shutter for a shutter that also tilts", () => {
    // Shutter is LF | TL, so it stays honest with or without tilt
    const mapping = deviceClassMapping(entity("shutter", 143));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Shutter);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.RollerShutter,
    );
  });

  it("maps window to Rollershade + RollerShade", () => {
    const mapping = deviceClassMapping(entity("window"));
    expect(mapping?.type).toBe(WindowCovering.WindowCoveringType.Rollershade);
    expect(mapping?.endProductType).toBe(
      WindowCovering.EndProductType.RollerShade,
    );
  });

  it("covers every documented key", () => {
    expect(Object.keys(DEVICE_CLASS_TO_MATTER_TYPE).sort()).toEqual([
      "awning",
      "blind",
      "curtain",
      "shade",
      "shutter",
      "window",
    ]);
  });
});

describe("liftShouldUseTilt", () => {
  it("is true for a tilt-only cover (#350, supported_features=240)", () => {
    expect(liftShouldUseTilt(240)).toBe(true);
  });

  it("is true for tilt open/close without set_tilt_position (48)", () => {
    expect(liftShouldUseTilt(48)).toBe(true);
  });

  it("is false for a lift-only cover (7 = open+close+set_position)", () => {
    expect(liftShouldUseTilt(7)).toBe(false);
  });

  it("is false for a lift+tilt cover (23, #323)", () => {
    expect(liftShouldUseTilt(23)).toBe(false);
  });

  it("is false for a binary cover (3 = open+close, #78)", () => {
    expect(liftShouldUseTilt(3)).toBe(false);
  });

  it("is false when no features are set (0)", () => {
    expect(liftShouldUseTilt(0)).toBe(false);
  });
});
