import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { Agent, EndpointType } from "@matter/main";
import { GroupsServer, ScenesManagementServer } from "@matter/main/behaviors";
import { ModeSelectDevice, OnOffPlugInUnitDevice } from "@matter/main/devices";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import {
  buildSupportedModes,
  ModeSelectServer,
} from "../../../behaviors/mode-select-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

interface SelectAttributes {
  options?: string[];
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
    OnOffServer({
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

export function SelectDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const asSwitch = selectAsSwitch(homeAssistantEntity, SelectSwitchType);
  if (asSwitch) {
    return asSwitch;
  }
  const attrs = homeAssistantEntity.entity.state.attributes as SelectAttributes;
  const options = attrs.options ?? [];

  if (options.length === 0) {
    return undefined;
  }

  const currentOption = homeAssistantEntity.entity.state.state;
  const currentIndex = currentOption
    ? options.findIndex((o) => o.toLowerCase() === currentOption.toLowerCase())
    : 0;

  return SelectEndpointType.set({
    homeAssistantEntity,
    modeSelect: {
      description:
        homeAssistantEntity.customName ??
        (
          homeAssistantEntity.entity.state.attributes as {
            friendly_name?: string;
          }
        ).friendly_name ??
        "Select",
      supportedModes: buildSupportedModes(options),
      currentMode: currentIndex >= 0 ? currentIndex : 0,
    },
  });
}

export function InputSelectDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const asSwitch = selectAsSwitch(homeAssistantEntity, InputSelectSwitchType);
  if (asSwitch) {
    return asSwitch;
  }
  const attrs = homeAssistantEntity.entity.state.attributes as SelectAttributes;
  const options = attrs.options ?? [];

  if (options.length === 0) {
    return undefined;
  }

  const currentOption = homeAssistantEntity.entity.state.state;
  const currentIndex = currentOption
    ? options.findIndex((o) => o.toLowerCase() === currentOption.toLowerCase())
    : 0;

  return InputSelectEndpointType.set({
    homeAssistantEntity,
    modeSelect: {
      description:
        homeAssistantEntity.customName ??
        (
          homeAssistantEntity.entity.state.attributes as {
            friendly_name?: string;
          }
        ).friendly_name ??
        "Input Select",
      supportedModes: buildSupportedModes(options),
      currentMode: currentIndex >= 0 ? currentIndex : 0,
    },
  });
}
