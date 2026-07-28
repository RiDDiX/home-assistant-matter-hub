import type { EndpointType } from "@matter/main";
import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HaElectricalEnergyMeasurementServer } from "../../../behaviors/electrical-energy-measurement-server.js";
import { HaElectricalPowerMeasurementServer } from "../../../behaviors/electrical-power-measurement-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";
import { DefaultPowerSourceServer } from "../../../behaviors/power-source-server.js";
import { HaPowerTopologyServer } from "../../../behaviors/power-topology-server.js";

const SwitchOnOffServer = OnOffServer();

const SwitchEndpointType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  SwitchOnOffServer,
);

const SwitchWithBatteryEndpointType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  GroupsServer,
  ScenesManagementServer,
  SwitchOnOffServer,
  DefaultPowerSourceServer,
);

export function SwitchDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  const attrs = homeAssistantEntity.entity.state.attributes as {
    battery?: number;
    battery_level?: number;
  };
  const hasBatteryAttr = attrs.battery_level != null || attrs.battery != null;
  const hasBatteryEntity = !!homeAssistantEntity.mapping?.batteryEntity;
  const hasPowerEntity = !!homeAssistantEntity.mapping?.powerEntity;
  const hasEnergyEntity = !!homeAssistantEntity.mapping?.energyEntity;
  // Voltage/current can be mapped on their own, so gate the power cluster on
  // any of the three or that data would be dropped.
  const hasElectricalPower =
    hasPowerEntity ||
    !!homeAssistantEntity.mapping?.voltageEntity ||
    !!homeAssistantEntity.mapping?.currentEntity;

  let device =
    hasBatteryAttr || hasBatteryEntity
      ? SwitchWithBatteryEndpointType
      : SwitchEndpointType;

  if (hasElectricalPower || hasEnergyEntity) {
    device = device.with(HaPowerTopologyServer);
  }
  if (hasElectricalPower) {
    device = device.with(HaElectricalPowerMeasurementServer);
  }
  if (hasEnergyEntity) {
    device = device.with(HaElectricalEnergyMeasurementServer);
  }

  return device.set({ homeAssistantEntity });
}
