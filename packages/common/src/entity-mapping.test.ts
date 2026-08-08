import { describe, expect, it } from "vitest";
import {
  type ControllerSupport,
  matterDeviceTypeControllerSupport,
  matterDeviceTypeLabels,
} from "./entity-mapping.js";

describe("matterDeviceTypeControllerSupport", () => {
  it("has exactly one entry per device-type label", () => {
    expect(Object.keys(matterDeviceTypeControllerSupport).sort()).toEqual(
      Object.keys(matterDeviceTypeLabels).sort(),
    );
  });

  it("uses only valid support values", () => {
    const allowed: ControllerSupport[] = ["yes", "partial", "no", "unknown"];
    for (const [key, value] of Object.entries(
      matterDeviceTypeControllerSupport,
    )) {
      for (const support of [
        value.apple,
        value.google,
        value.alexa,
        value.aqara,
      ]) {
        expect(allowed, `${key}: ${support}`).toContain(support);
      }
    }
  });

  it("encodes the verified controller facts so a future edit cannot regress them", () => {
    // RVC works on Apple since iOS 18.4
    expect(matterDeviceTypeControllerSupport.robot_vacuum_cleaner.apple).toBe(
      "yes",
    );
    // Google does not support Mode Select (#356)
    expect(matterDeviceTypeControllerSupport.mode_select.google).toBe("no");
    // Speaker is Google-only
    expect(matterDeviceTypeControllerSupport.speaker.apple).toBe("no");
    expect(matterDeviceTypeControllerSupport.speaker.google).toBe("yes");
    expect(matterDeviceTypeControllerSupport.speaker.alexa).toBe("no");
    // Apple added leak/smoke alarms in iOS 18.4
    expect(matterDeviceTypeControllerSupport.water_leak_detector.apple).toBe(
      "yes",
    );
    expect(matterDeviceTypeControllerSupport.smoke_co_alarm.apple).toBe("yes");
    // Aqara surfaces leak detectors and speakers that the others reject
    expect(matterDeviceTypeControllerSupport.water_leak_detector.aqara).toBe(
      "yes",
    );
    expect(matterDeviceTypeControllerSupport.speaker.aqara).toBe("yes");
  });
});
