import {
  type HomeAssistantEntityInformation,
  type SensorDeviceAttributes,
  SensorDeviceClass,
} from "@home-assistant-matter-hub/common";
import {
  ElectricalEnergyMeasurementServer as EnergyBase,
  ElectricalPowerMeasurementServer as PowerBase,
} from "@matter/main/behaviors";
import { ElectricalPowerMeasurement } from "@matter/main/clusters";
import { SolarPowerDevice } from "@matter/main/devices";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { HaPowerTopologyServer } from "../../../../behaviors/power-topology-server.js";

const PowerFeaturedBase = PowerBase.with("AlternatingCurrent");

// Power server for standalone electrical sensors. The primary entity drives the
// attribute matching its own device_class; mapped power/voltage/current sensors
// fold their measurements onto the same endpoint so one device carries them all.
// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class StandalonePowerServer extends PowerFeaturedBase {
  declare state: StandalonePowerServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    const patch: {
      activePower?: number;
      voltage?: number;
      activeCurrent?: number;
    } = {};

    // Primary sensor: value goes to the attribute for its own device_class.
    const attrs = entity.state?.attributes as
      | SensorDeviceAttributes
      | undefined;
    const dc = attrs?.device_class;
    const primary = entity.state?.state;
    if (primary != null && !Number.isNaN(+primary)) {
      if (dc === SensorDeviceClass.power) {
        patch.activePower = Math.round(+primary * 1000);
      } else if (dc === SensorDeviceClass.voltage) {
        patch.voltage = Math.round(+primary * 1000);
      } else if (dc === SensorDeviceClass.current) {
        patch.activeCurrent = Math.round(+primary * 1000);
      }
    }

    // Mapped companions (W*1000 mW, V*1000 mV, A*1000 mA).
    const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
    if (
      mapping?.powerEntity ||
      mapping?.voltageEntity ||
      mapping?.currentEntity
    ) {
      const stateProvider = this.agent.env.get(EntityStateProvider);
      if (mapping.powerEntity) {
        const w = stateProvider.getNumericState(mapping.powerEntity);
        if (w != null) patch.activePower = Math.round(w * 1000);
      }
      if (mapping.voltageEntity) {
        const v = stateProvider.getNumericState(mapping.voltageEntity);
        if (v != null) patch.voltage = Math.round(v * 1000);
      }
      if (mapping.currentEntity) {
        const a = stateProvider.getNumericState(mapping.currentEntity);
        if (a != null) patch.activeCurrent = Math.round(a * 1000);
      }
    }

    if (Object.keys(patch).length > 0) applyPatchState(this.state, patch);
  }
}

namespace StandalonePowerServer {
  export class State extends PowerFeaturedBase.State {}
}

export const PowerServer = StandalonePowerServer.set({
  powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
  // Power, voltage and current can all be folded onto this endpoint, so the
  // accuracy list carries an entry for each reported measurement type.
  numberOfMeasurementTypes: 3,
  // SmartThings keeps the endpoint in a "device not yet updated" state
  // when activePower stays null. Seed 0 so the cluster reports a value
  // for energy/voltage/current-only sensors that never feed activePower.
  activePower: 0,
  accuracy: [
    {
      measurementType: ElectricalPowerMeasurement.MeasurementType.ActivePower,
      measured: true,
      minMeasuredValue: -1_000_000,
      maxMeasuredValue: 100_000_000,
      accuracyRanges: [
        {
          rangeMin: -1_000_000,
          rangeMax: 100_000_000,
          fixedMax: 1000,
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
          fixedMax: 1000,
        },
      ],
    },
    {
      measurementType: ElectricalPowerMeasurement.MeasurementType.ActiveCurrent,
      measured: true,
      minMeasuredValue: -1_000_000, // -1000A in mA
      maxMeasuredValue: 1_000_000, // 1000A in mA
      accuracyRanges: [
        {
          rangeMin: -1_000_000,
          rangeMax: 1_000_000,
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

// Energy server for standalone electrical sensors. Reads the primary entity when
// it is an energy sensor, plus a mapped energy companion for lifetime totals.
// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class StandaloneEnergyServer extends EnergyFeaturedBase {
  declare state: StandaloneEnergyServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    let energyKwh: number | null = null;

    const attrs = entity.state?.attributes as
      | SensorDeviceAttributes
      | undefined;
    if (attrs?.device_class === SensorDeviceClass.energy) {
      const state = entity.state?.state;
      if (state != null && !Number.isNaN(+state)) energyKwh = +state;
    }

    const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
    if (mapping?.energyEntity) {
      const stateProvider = this.agent.env.get(EntityStateProvider);
      const mapped = stateProvider.getNumericState(mapping.energyEntity);
      if (mapped != null) energyKwh = mapped;
    }

    if (energyKwh == null) return;

    const energyImported = { energy: Math.round(energyKwh * 1_000_000) };
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

namespace StandaloneEnergyServer {
  export class State extends EnergyFeaturedBase.State {}
}

export const EnergyServer = StandaloneEnergyServer.set({
  // Match the activePower=0 default so SmartThings doesn't show "- kWh"
  // on an endpoint whose mapped entity only carries power data.
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

// SolarPower (0x0017) for generation. Kept for the solar_power / electrical_sensor
// overrides; consumption sensors default to ElectricalMeter (0x0514) instead.
export const ElectricalSensorType = SolarPowerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaPowerTopologyServer,
  PowerServer,
  EnergyServer,
);
