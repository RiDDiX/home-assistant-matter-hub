import { ElectricalMeterDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { HaPowerTopologyServer } from "../../../../behaviors/power-topology-server.js";
import { EnergyServer, PowerServer } from "./electrical-sensor.js";

// ElectricalMeter (0x0514) is the default for consumption electrical sensors
// (device_class power/energy/voltage/current). Google Home and SmartThings
// render it, unlike SolarPower. Its two measurement clusters are seeded (see
// PowerServer/EnergyServer), so the mandatory attributes never brick it (#419).
// PowerTopology is mandatory here: ElectricalMeter requires the ElectricalSensor
// device type, which requires the cluster. matter.js does not enforce it.
export const ElectricalMeterType = ElectricalMeterDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  PowerServer,
  EnergyServer,
  HaPowerTopologyServer,
);
