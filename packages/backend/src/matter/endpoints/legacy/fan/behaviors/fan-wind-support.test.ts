import { describe, expect, it } from "vitest";
import { windSupportFor } from "./fan-fan-control-server.js";

describe("windSupportFor", () => {
  it("claims only sleep when the entity has no natural preset", () => {
    // A VeSync air purifier whose only preset is "sleep" was advertising
    // naturalWind too, so controllers offered "Natural" and Home Assistant
    // answered: Preset mode Natural is not valid, valid preset modes are: sleep
    expect(windSupportFor(["sleep"], {})).toEqual({
      naturalWind: false,
      sleepWind: true,
    });
  });

  it("claims only natural when that is the sole wind preset", () => {
    expect(windSupportFor(["natural"], {})).toEqual({
      naturalWind: true,
      sleepWind: false,
    });
  });

  it("claims both when both presets exist", () => {
    expect(windSupportFor(["Natural", "Sleep", "Auto"], {})).toEqual({
      naturalWind: true,
      sleepWind: true,
    });
  });

  it("claims nothing when the entity has no wind presets", () => {
    expect(windSupportFor(["auto", "turbo"], {})).toEqual({
      naturalWind: false,
      sleepWind: false,
    });
    expect(windSupportFor(undefined, {})).toEqual({
      naturalWind: false,
      sleepWind: false,
    });
  });

  it("honours localized preset names from the entity mapping", () => {
    expect(
      windSupportFor(["Viento natural"], { natural: ["Viento natural"] }),
    ).toEqual({ naturalWind: true, sleepWind: false });
    expect(windSupportFor(["Nocturno"], { sleep: ["Nocturno"] })).toEqual({
      naturalWind: false,
      sleepWind: true,
    });
  });
});
