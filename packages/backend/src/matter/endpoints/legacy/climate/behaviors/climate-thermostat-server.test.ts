import {
  type ClimateDeviceAttributes,
  ClimateHvacAction,
  ClimateHvacMode,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Thermostat } from "@matter/main/clusters";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyClimateFreezeForKeepModeOnIdle,
  climateFreezeState,
} from "./climate-thermostat-server.js";

const entityId = "climate.test";

function state(
  hvacState: ClimateHvacMode,
  action: ClimateHvacAction,
): HomeAssistantEntityState {
  return {
    entity_id: entityId,
    state: hvacState,
    context: { id: "ctx" },
    last_changed: "x",
    last_updated: "x",
    attributes: {
      hvac_action: action,
      hvac_modes: [ClimateHvacMode.cool, ClimateHvacMode.off],
    } as ClimateDeviceAttributes,
  };
}

describe("applyClimateFreezeForKeepModeOnIdle (#340)", () => {
  beforeEach(() => {
    climateFreezeState.delete(entityId);
  });

  it("keeps Cool across cool > transient off+off > off+idle", () => {
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Cool,
        state(ClimateHvacMode.cool, ClimateHvacAction.cooling),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Cool);
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.off),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Cool);
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.idle),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Cool);
  });

  it("returns Off for off+off > off+idle when no mode was ever armed", () => {
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.off),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Off);
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.idle),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Off);
  });

  it("clears the freeze on the second consecutive off", () => {
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Cool,
      state(ClimateHvacMode.cool, ClimateHvacAction.cooling),
      entityId,
      true,
    );
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Off,
      state(ClimateHvacMode.off, ClimateHvacAction.off),
      entityId,
      true,
    );
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.off),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Off);
  });

  it("does not return frozen mode when option is disabled", () => {
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Cool,
      state(ClimateHvacMode.cool, ClimateHvacAction.cooling),
      entityId,
      false,
    );
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.idle),
        entityId,
        false,
      ),
    ).toBe(Thermostat.SystemMode.Off);
  });

  it("resets the confirm gate when an idle arrives between two offs", () => {
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Cool,
      state(ClimateHvacMode.cool, ClimateHvacAction.cooling),
      entityId,
      true,
    );
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Off,
      state(ClimateHvacMode.off, ClimateHvacAction.off),
      entityId,
      true,
    );
    applyClimateFreezeForKeepModeOnIdle(
      Thermostat.SystemMode.Off,
      state(ClimateHvacMode.off, ClimateHvacAction.idle),
      entityId,
      true,
    );
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.off),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Cool);
    expect(
      applyClimateFreezeForKeepModeOnIdle(
        Thermostat.SystemMode.Off,
        state(ClimateHvacMode.off, ClimateHvacAction.off),
        entityId,
        true,
      ),
    ).toBe(Thermostat.SystemMode.Off);
  });
});
