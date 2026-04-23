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
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class StandalonePowerServer extends PowerBase {
  declare state: StandalonePowerServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const state = entity.state.state;
    if (state == null || Number.isNaN(+state)) return;

    const attrs = entity.state.attributes as SensorDeviceAttributes;
    const dc = attrs.device_class;

    if (dc === SensorDeviceClass.power) {
      applyPatchState(this.state, {
        activePower: Math.round(+state * 1000),
      });
    } else if (dc === SensorDeviceClass.voltage) {
      applyPatchState(this.state, {
        voltage: Math.round(+state * 1000),
      });
    } else if (dc === SensorDeviceClass.current) {
      applyPatchState(this.state, {
        activeCurrent: Math.round(+state * 1000),
      });
    }
  }
}

namespace StandalonePowerServer {
  export class State extends PowerBase.State {}
}

const PowerServer = StandalonePowerServer.set({
  powerMode: ElectricalPowerMeasurement.PowerMode.Ac,
  numberOfMeasurementTypes: 1,
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
  ],
});

const EnergyFeaturedBase = EnergyBase.with(
  "CumulativeEnergy",
  "ImportedEnergy",
);

// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class StandaloneEnergyServer extends EnergyFeaturedBase {
  declare state: StandaloneEnergyServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const attrs = entity.state.attributes as SensorDeviceAttributes;
    if (attrs.device_class !== SensorDeviceClass.energy) return;

    const state = entity.state.state;
    if (state == null || Number.isNaN(+state)) return;

    const energyMwh = Math.round(+state * 1_000_000);
    const energyImported = { energy: energyMwh };

    applyPatchState(this.state, {
      cumulativeEnergyImported: energyImported,
    });

    this.events.cumulativeEnergyMeasured?.emit(
      { energyImported, energyExported: undefined },
      this.context,
    );
  }
}

namespace StandaloneEnergyServer {
  export class State extends EnergyFeaturedBase.State {}
}

const EnergyServer = StandaloneEnergyServer.set({
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

export const ElectricalSensorType = SolarPowerDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  PowerServer,
  EnergyServer,
);
