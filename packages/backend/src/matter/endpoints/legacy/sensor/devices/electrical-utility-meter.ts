import { MeterIdentificationServer } from "@matter/main/behaviors";
import { ElectricalUtilityMeterDevice } from "@matter/main/devices";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { HaPowerTopologyServer } from "../../../../behaviors/power-topology-server.js";
import { EnergyServer, PowerServer } from "./electrical-sensor.js";

// Serial number and point of delivery come from the entity mapping when the
// user filled them in; everything else stays null (spec: null = unavailable).
// biome-ignore lint/correctness/noUnusedVariables: Used via namespace
class HaMeterIdentificationServer extends MeterIdentificationServer {
  declare state: HaMeterIdentificationServer.State;

  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    const mapping = homeAssistant.state.mapping;
    applyPatchState(this.state, {
      meterSerialNumber: mapping?.meterSerialNumber ?? null,
      pointOfDelivery: mapping?.pointOfDelivery ?? null,
    });
  }
}

namespace HaMeterIdentificationServer {
  export class State extends MeterIdentificationServer.State {}
}

// ElectricalUtilityMeter (0x0511), opt-in via the entity mapping. The model
// mandates only MeterIdentification, whose attributes are all nullable, so
// they are seeded null to survive mount (#419). The entity's readings ride on
// the same endpoint through the shared Power/Energy servers; PowerTopology
// scopes them to this endpoint (#431) and makes matter.js advertise the
// ElectricalSensor device type that spec-wise hosts measurement clusters.
export const ElectricalUtilityMeterType = ElectricalUtilityMeterDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  HaMeterIdentificationServer.set({
    meterType: null,
    pointOfDelivery: null,
    meterSerialNumber: null,
  }),
  PowerServer,
  EnergyServer,
  HaPowerTopologyServer,
);
