import { Logger } from "@matter/general";
import { ElectricalEnergyMeasurementServer as Base } from "@matter/main/behaviors";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { EntityStateProvider } from "../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("ElectricalEnergyMeasurementServer");

const FeaturedBase = Base.with("CumulativeEnergy", "ImportedEnergy");

// biome-ignore lint/correctness/noUnusedVariables: Used by the function below
class ElectricalEnergyMeasurementServerBase extends FeaturedBase {
  declare state: ElectricalEnergyMeasurementServerBase.State;

  override async initialize() {
    await super.initialize();

    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const entityId = homeAssistant.entityId;
    const energyEntity = homeAssistant.state.mapping?.energyEntity;

    if (energyEntity) {
      logger.debug(
        `[${entityId}] ElectricalEnergyMeasurement using mapped energy entity: ${energyEntity}`,
      );
    }

    this.update();
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const energyEntity = homeAssistant.state.mapping?.energyEntity;

    if (!energyEntity) return;

    const stateProvider = this.agent.env.get(EntityStateProvider);
    const energyKwh = stateProvider.getNumericState(energyEntity);

    if (energyKwh == null) return;

    // Matter uses milliwatt-hours (mWh)
    const energyMwh = Math.round(energyKwh * 1_000_000);

    const energyImported = { energy: energyMwh };

    applyPatchState(this.state, {
      cumulativeEnergyImported: energyImported,
    });

    // Matter spec requires emitting cumulativeEnergyMeasured event
    // when cumulative energy values change (see matter.js setMeasurement)
    this.events.cumulativeEnergyMeasured?.emit(
      { energyImported, energyExported: undefined },
      this.context,
    );
  }
}

namespace ElectricalEnergyMeasurementServerBase {
  export class State extends FeaturedBase.State {}
}

export const HaElectricalEnergyMeasurementServer =
  ElectricalEnergyMeasurementServerBase.set({
    // Match the activePower=0 default in HaElectricalPowerMeasurementServer
    // so SmartThings doesn't show "- kWh" before the first state update or
    // when an entity only carries power (not energy) data.
    cumulativeEnergyImported: { energy: 0 },
    accuracy: {
      measurementType:
        ElectricalPowerMeasurement.MeasurementType.ElectricalEnergy,
      measured: true,
      minMeasuredValue: -1_000_000, // -1000Wh, allows 0 and all positive values
      maxMeasuredValue: 100_000_000_000, // 100MWh in mWh
      accuracyRanges: [
        {
          rangeMin: -1_000_000,
          rangeMax: 100_000_000_000,
          fixedMax: 1000, // 1Wh accuracy
        },
      ],
    },
  });
