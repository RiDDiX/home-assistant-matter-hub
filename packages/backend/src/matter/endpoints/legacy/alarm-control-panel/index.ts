import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import type { EndpointType } from "@matter/main";
import { ModeSelectDevice, OnOffPlugInUnitDevice } from "@matter/main/devices";
import type { HomeAssistantAction } from "../../../../services/home-assistant/home-assistant-actions.js";
import { BasicInformationServer } from "../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../behaviors/identify-server.js";
import { ModeSelectServer } from "../../../behaviors/mode-select-server.js";
import { OnOffServer } from "../../../behaviors/on-off-server.js";

// Matter has no dedicated alarm/security panel device type.
// ModeSelect (0x27) is the best fit: each alarm arm mode becomes a selectable
// mode, preserving Home / Away / Night / Vacation / Custom / Disarmed states
// instead of collapsing to a simple on/off toggle.

// HA alarm_control_panel supported feature flags
const FEATURE_ARM_HOME = 1;
const FEATURE_ARM_AWAY = 2;
const FEATURE_ARM_NIGHT = 4;
const FEATURE_ARM_CUSTOM_BYPASS = 16;
const FEATURE_ARM_VACATION = 32;

interface AlarmMode {
  label: string;
  haState: string;
  action: string;
  featureFlag?: number;
}

// All possible alarm modes. "Disarmed" has no featureFlag, always included.
const ALL_ALARM_MODES: AlarmMode[] = [
  {
    label: "Disarmed",
    haState: "disarmed",
    action: "alarm_control_panel.alarm_disarm",
  },
  {
    label: "Armed Home",
    haState: "armed_home",
    action: "alarm_control_panel.alarm_arm_home",
    featureFlag: FEATURE_ARM_HOME,
  },
  {
    label: "Armed Away",
    haState: "armed_away",
    action: "alarm_control_panel.alarm_arm_away",
    featureFlag: FEATURE_ARM_AWAY,
  },
  {
    label: "Armed Night",
    haState: "armed_night",
    action: "alarm_control_panel.alarm_arm_night",
    featureFlag: FEATURE_ARM_NIGHT,
  },
  {
    label: "Armed Vacation",
    haState: "armed_vacation",
    action: "alarm_control_panel.alarm_arm_vacation",
    featureFlag: FEATURE_ARM_VACATION,
  },
  {
    label: "Armed Custom",
    haState: "armed_custom_bypass",
    action: "alarm_control_panel.alarm_arm_custom_bypass",
    featureFlag: FEATURE_ARM_CUSTOM_BYPASS,
  },
];

interface AlarmPanelAttributes {
  supported_features?: number;
}

function getAlarmModes(attrs: AlarmPanelAttributes): AlarmMode[] {
  const features = attrs.supported_features ?? 0;
  // If no features specified, include Disarmed + Armed Away as minimal set
  if (features === 0) {
    return ALL_ALARM_MODES.filter(
      (m) => !m.featureFlag || m.featureFlag === FEATURE_ARM_AWAY,
    );
  }
  return ALL_ALARM_MODES.filter(
    (m) => !m.featureFlag || (features & m.featureFlag) !== 0,
  );
}

function getAlarmOptions(entity: HomeAssistantEntityInformation): string[] {
  const attrs = entity.state.attributes as AlarmPanelAttributes;
  return getAlarmModes(attrs).map((m) => m.label);
}

function getCurrentAlarmOption(
  entity: HomeAssistantEntityInformation,
): string | undefined {
  const attrs = entity.state.attributes as AlarmPanelAttributes;
  const modes = getAlarmModes(attrs);
  // Transitional states (arming, pending, triggered) won't match any mode
  // and ModeSelectServer defaults to index 0 ("Disarmed"), which is acceptable.
  const mode = modes.find((m) => m.haState === entity.state.state);
  return mode?.label;
}

function selectAlarmOption(option: string): HomeAssistantAction {
  const mode = ALL_ALARM_MODES.find((m) => m.label === option);
  return { action: mode?.action ?? "alarm_control_panel.alarm_disarm" };
}

const AlarmModeServer = ModeSelectServer({
  getOptions: getAlarmOptions,
  getCurrentOption: getCurrentAlarmOption,
  selectOption: selectAlarmOption,
});

const AlarmPanelEndpointType = ModeSelectDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  AlarmModeServer,
);

// OnOffPlugInUnit fallback for controllers that don't support ModeSelect
// (Apple Home, Google Home, SmartThings, Tuya).
// On = arm (uses first available arm mode), Off = disarm.
const AlarmOnOffServer = OnOffServer({
  isOn: (entityState, agent) => {
    return (
      agent.get(HomeAssistantEntityBehavior).isAvailable &&
      entityState.state !== "disarmed"
    );
  },
  turnOn: (_, agent) => {
    const ha = agent.get(HomeAssistantEntityBehavior);
    const features =
      (ha.entity.state.attributes as AlarmPanelAttributes).supported_features ??
      0;
    if (features & FEATURE_ARM_AWAY)
      return { action: "alarm_control_panel.alarm_arm_away" };
    if (features & FEATURE_ARM_HOME)
      return { action: "alarm_control_panel.alarm_arm_home" };
    if (features & FEATURE_ARM_NIGHT)
      return { action: "alarm_control_panel.alarm_arm_night" };
    return { action: "alarm_control_panel.alarm_arm_away" };
  },
  turnOff: () => ({ action: "alarm_control_panel.alarm_disarm" }),
});

const AlarmOnOffEndpointType = OnOffPlugInUnitDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  AlarmOnOffServer,
);

export function AlarmOnOffDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType {
  return AlarmOnOffEndpointType.set({ homeAssistantEntity });
}

export function AlarmControlPanelDevice(
  homeAssistantEntity: HomeAssistantEntityBehavior.State,
): EndpointType | undefined {
  const attrs = homeAssistantEntity.entity.state
    .attributes as AlarmPanelAttributes;
  const modes = getAlarmModes(attrs);

  if (modes.length === 0) {
    return undefined;
  }

  const currentMode = modes.find(
    (m) => m.haState === homeAssistantEntity.entity.state.state,
  );
  const currentIndex = currentMode ? modes.indexOf(currentMode) : 0;

  return AlarmPanelEndpointType.set({
    homeAssistantEntity,
    modeSelect: {
      description:
        homeAssistantEntity.customName ??
        (
          homeAssistantEntity.entity.state.attributes as {
            friendly_name?: string;
          }
        ).friendly_name ??
        "Alarm Panel",
      supportedModes: modes.map((m, index) => ({
        label: m.label,
        mode: index,
        semanticTags: [],
      })),
      currentMode: currentIndex >= 0 ? currentIndex : 0,
    },
  });
}
