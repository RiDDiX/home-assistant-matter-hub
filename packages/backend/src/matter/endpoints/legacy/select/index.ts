import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { Agent, EndpointType } from "@matter/main";
import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { ModeSelectDevice, OnOffPlugInUnitDevice } from "@matter/main/devices";
import { trimToLength } from "../../../../utils/trim-to-length.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  buildSupportedModes,
  findCurrentMode,
  ModeSelectServer,
} from "../../../behaviors/mode-select-server.js";
import { PlugOnOffServer } from "../../../behaviors/on-off-server.js";

interface SelectAttributes {
  options?: string[];
  friendly_name?: string;
}

function getSelectOptions(entity: HomeAssistantEntityInformation): string[] {
  const attrs = entity.state.attributes as SelectAttributes;
  return attrs.options ?? [];
}

function buildSelectModeServer(action: string) {
  return ModeSelectServer({
    getOptions: getSelectOptions,
    getCurrentOption: (entity) => entity.state.state ?? undefined,
    selectOption: (option) => ({
      action,
      data: { option },
    }),
  });
}

const SelectModeServer = buildSelectModeServer("select.select_option");
const InputSelectModeServer = buildSelectModeServer(
  "input_select.select_option",
);

// Controllers can't render ModeSelect (#356), so a select can opt into a
// plain switch instead: "on" and "off" each select a configured option.
function buildSelectSwitchType(action: string) {
  const option = (agent: Agent, key: "on" | "off") => {
    const mapping = agent.get(HomeAssistantEntityBehavior).state.mapping;
    return key === "on"
      ? mapping?.selectSwitchOnOption
      : mapping?.selectSwitchOffOption;
  };
  return OnOffPlugInUnitDevice.with(
    BasicInformationServer,
    IdentifyServer,
    HomeAssistantEntityBehavior,
    GroupsServer,
    ScenesManagementServer,
    PlugOnOffServer({
      // Case-insensitive like the ModeSelect path, some integrations
      // report options with different casing.
      isOn: (state, agent) =>
        state.state?.toLowerCase() === option(agent, "on")?.toLowerCase(),
      turnOn: (_, agent) => ({
        action,
        data: { option: option(agent, "on") },
      }),
      turnOff: (_, agent) => ({
        action,
        data: { option: option(agent, "off") },
      }),
    }),
  );
}

const SelectSwitchType = buildSelectSwitchType("select.select_option");
const InputSelectSwitchType = buildSelectSwitchType(
  "input_select.select_option",
);

function selectAsSwitch(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
  type: typeof SelectSwitchType,
): EndpointType | undefined {
  const mapping = homeAssistantEntity.mapping;
  if (
    mapping?.selectExposeAsSwitch !== true ||
    !mapping.selectSwitchOnOption ||
    !mapping.selectSwitchOffOption
  ) {
    return undefined;
  }
  return type.set({ homeAssistantEntity });
}

const SelectEndpointType = ModeSelectDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  SelectModeServer,
);

const InputSelectEndpointType = ModeSelectDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  InputSelectModeServer,
);

function modeSelectState(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
  fallbackName: string,
) {
  const attrs = homeAssistantEntity.entity.state.attributes as SelectAttributes;
  const options = attrs.options ?? [];
  if (options.length === 0) {
    return undefined;
  }
  return {
    homeAssistantEntity,
    modeSelect: {
      description:
        trimToLength(
          homeAssistantEntity.customName ?? attrs.friendly_name,
          64,
          "...",
        ) ?? fallbackName,
      supportedModes: buildSupportedModes(options),
      currentMode: findCurrentMode(
        options,
        homeAssistantEntity.entity.state.state,
      ),
    },
  };
}

export function SelectDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const state = modeSelectState(homeAssistantEntity, "Select");
  return (
    selectAsSwitch(homeAssistantEntity, SelectSwitchType) ??
    (state && SelectEndpointType.set(state))
  );
}

export function InputSelectDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const state = modeSelectState(homeAssistantEntity, "Input Select");
  return (
    selectAsSwitch(homeAssistantEntity, InputSelectSwitchType) ??
    (state && InputSelectEndpointType.set(state))
  );
}
