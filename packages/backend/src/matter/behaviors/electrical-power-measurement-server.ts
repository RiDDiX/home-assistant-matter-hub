import { Logger } from "@matter/general";
import { ElectricalPowerMeasurementServer as Base } from "@matter/main/behaviors";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("ElectricalPowerMeasurementServer");

const FeaturedBase = Base.with("AlternatingCurrent");

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace below
class ElectricalPowerMeasurementServerBase extends FeaturedBase {
  declare state: ElectricalPowerMeasurementServerBase.State;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;
    const powerEntity = homeAssistant.state.mapping?.powerEntity;

    if (powerEntity) {
      logger.debug(
        `[${entityId}] ElectricalPowerMeasurement using mapped power entity: ${powerEntity}`,
      );
    }

    this.update();
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const mapping = homeAssistant.state.mapping;
    const powerEntity = mapping?.powerEntity;
    const voltageEntity = mapping?.voltageEntity;
    const currentEntity = mapping?.currentEntity;

    if (!powerEntity && !voltageEntity && !currentEntity) return;

    const stateProvider = this.agent.env.get(EntityStateProvider);
    // Skip null values to avoid validation errors; only patch what is present.
    const patch: {
      activePower?: number;
      voltage?: number;
      activeCurrent?: number;
    } = {};

    if (powerEntity) {
      const powerWatts = stateProvider.getNumericState(powerEntity);
      // Matter uses milliwatts (int64)
      if (powerWatts != null) patch.activePower = Math.round(powerWatts * 1000);
    }
    if (voltageEntity) {
      const volts = stateProvider.getNumericState(voltageEntity);
      // Matter uses millivolts
      if (volts != null) patch.voltage = Math.round(volts * 1000);
    }
    if (currentEntity) {
      const amps = stateProvider.getNumericState(currentEntity);
      // Matter uses milliamps
      if (amps != null) patch.activeCurrent = Math.round(amps * 1000);
    }

    if (Object.keys(patch).length > 0) applyPatchState(this.state, patch);
  }
}

namespace ElectricalPowerMeasurementServerBase {
  export class State extends FeaturedBase.State {}
}

export const HaElectricalPowerMeasurementServer =
  ElectricalPowerMeasurementServerBase.set({
    powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
    // Voltage and current are folded onto this endpoint when mapped, so the
    // accuracy list carries an entry for each reported measurement type.
    numberOfMeasurementTypes: 3,
    accuracy: [
      {
        measurementType: ElectricalPowerMeasurement.MeasurementType.ActivePower,
        measured: true,
        minMeasuredValue: -1_000_000, // -1000W, allows 0 and all positive values
        maxMeasuredValue: 100_000_000, // 100kW in mW
        accuracyRanges: [
          {
            rangeMin: -1_000_000,
            rangeMax: 100_000_000,
            fixedMax: 1000, // 1W accuracy
          },
        ],
      },
      {
        measurementType: ElectricalPowerMeasurement.MeasurementType.Voltage,
        measured: true,
        minMeasuredValue: 0,
        maxMeasuredValue: 1_000_000, // 1000V in mV
        accuracyRanges: [
          {
            rangeMin: 0,
            rangeMax: 1_000_000,
            fixedMax: 1000, // 1V accuracy
          },
        ],
      },
      {
        measurementType:
          ElectricalPowerMeasurement.MeasurementType.ActiveCurrent,
        measured: true,
        minMeasuredValue: -1_000_000, // -1000A in mA
        maxMeasuredValue: 1_000_000, // 1000A in mA
        accuracyRanges: [
          {
            rangeMin: -1_000_000,
            rangeMax: 1_000_000,
            fixedMax: 1000, // 1A accuracy
          },
        ],
      },
    ],
  });
