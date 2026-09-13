import type { EntityMappingConfig } from "@home-assistant-matter-hub/common";
import {
  ElectricalEnergyMeasurementServer as EnergyBase,
  ElectricalPowerMeasurementServer as PowerBase,
} from "@matter/main/behaviors";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { BatteryStorageDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { PowerSourceServer } from "../../../../behaviors/power-source-server.js";
import { HaPowerTopologyServer } from "../../../../behaviors/power-topology-server.js";

const PowerFeaturedBase = PowerBase.with("DirectCurrent");

// The mapped batteryPowerEntity reports W, positive on discharge. Matter wants
// imported power positive and exported negative, so the sign flips on the wire.
// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class EssPowerServer extends PowerFeaturedBase {
  declare state: EssPowerServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update();
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update() {
    const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
    const powerEntity = mapping?.batteryPowerEntity;
    if (!powerEntity) return;

    const stateProvider = this.agent.env.get(EntityStateProvider);
    const watts = stateProvider.getNumericState(powerEntity);
    if (watts == null) return;

    applyPatchState(this.state, { activePower: Math.round(watts * -1000) });
  }
}

namespace EssPowerServer {
  export class State extends PowerFeaturedBase.State {}
}

const EssPower = EssPowerServer.set({
  powerMode: ElectricalPowerMeasurement.PowerMode.Dc,
  numberOfMeasurementTypes: 1,
  // Seed 0 so the cluster reports a value before the first update (SmartThings).
  activePower: 0,
  accuracy: [
    {
      measurementType: ElectricalPowerMeasurement.MeasurementType.ActivePower,
      measured: true,
      // Wide symmetric range: batteries both charge (negative) and discharge.
      minMeasuredValue: -100_000_000,
      maxMeasuredValue: 100_000_000,
      accuracyRanges: [
        {
          rangeMin: -100_000_000,
          rangeMax: 100_000_000,
          fixedMax: 1000,
        },
      ],
    },
  ],
});

const EnergyFeaturedBase = EnergyBase.with(
  "CumulativeEnergy",
  "ImportedEnergy",
);

// Lifetime battery throughput from the mapped batteryEnergyEntity (kWh -> mWh).
// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class EssEnergyServer extends EnergyFeaturedBase {
  declare state: EssEnergyServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update();
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update() {
    const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
    const energyEntity = mapping?.batteryEnergyEntity;
    if (!energyEntity) return;

    const stateProvider = this.agent.env.get(EntityStateProvider);
    const kwh = stateProvider.getNumericState(energyEntity);
    if (kwh == null) return;

    const energyImported = { energy: Math.round(kwh * 1_000_000) };
    const changed = applyPatchState(this.state, {
      cumulativeEnergyImported: energyImported,
    });
    // Only emit when the cumulative value actually moved; onChange fires for
    // any mapped attribute, not just this one.
    if ("cumulativeEnergyImported" in changed) {
      this.events.cumulativeEnergyMeasured?.emit(
        { energyImported, energyExported: undefined },
        this.context,
      );
    }
  }
}

namespace EssEnergyServer {
  export class State extends EnergyFeaturedBase.State {}
}

const EssEnergy = EssEnergyServer.set({
  cumulativeEnergyImported: { energy: 0 },
  accuracy: {
    measurementType:
      ElectricalPowerMeasurement.MeasurementType.ElectricalEnergy,
    measured: true,
    minMeasuredValue: -1_000_000,
    maxMeasuredValue: 100_000_000_000,
    accuracyRanges: [
      {
        rangeMin: -1_000_000,
        rangeMax: 100_000_000_000,
        fixedMax: 1000,
      },
    ],
  },
});

const BatteryStorageEssBase = BatteryStorageDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaPowerTopologyServer,
  PowerSourceServer({
    getBatteryPercent(entity) {
      const state = entity.state;
      if (state == null || Number.isNaN(+state)) {
        return null;
      }
      return +state;
    },
  }),
);

// BatteryStorage (0x0018) that also carries the electrical measurement clusters
// of a home battery. Only the clusters a mapping actually feeds get mounted,
// an unmapped one would advertise made-up zeros. A plain battery-percent
// sensor keeps the lighter BatterySensorType instead.
export function batteryStorageEssType(mapping?: EntityMappingConfig) {
  // biome-ignore lint/suspicious/noExplicitAny: .with() narrows the union type
  let device: any = BatteryStorageEssBase;
  if (mapping?.batteryPowerEntity) device = device.with(EssPower);
  if (mapping?.batteryEnergyEntity) device = device.with(EssEnergy);
  return device as typeof BatteryStorageEssBase;
}
