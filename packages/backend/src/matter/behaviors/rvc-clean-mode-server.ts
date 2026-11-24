import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { RvcCleanModeServer as Base } from "@matter/main/behaviors";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { RvcCleanMode } from "@matter/main/clusters/rvc-clean-mode";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import { clampCurrentMode } from "./utils/clamp-current-mode.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("RvcCleanModeServerBase");

// SupportedModes needs 2 to 255 entries (enforced since matter.js 0.18). A
// vacuum with nothing to choose still keeps the cluster for Alexa (#183), so
// it gets this second mode and refuses it. Vacuum builders never use mode 4.
const PLACEHOLDER_MODE: RvcCleanMode.ModeOption = {
  label: "Auto",
  mode: 4,
  modeTags: [
    { value: RvcCleanMode.ModeTag.Vacuum },
    { value: RvcCleanMode.ModeTag.Auto },
  ],
};

function withTwoModes(
  modes: RvcCleanMode.ModeOption[],
): RvcCleanMode.ModeOption[] {
  return modes.length > 1 ? modes : [...modes, PLACEHOLDER_MODE];
}

export interface RvcCleanModeServerConfig {
  // undefined means the live mode is unknown right now, keep the current one
  getCurrentMode: ValueGetter<number | undefined>;
  getSupportedModes: ValueGetter<RvcCleanMode.ModeOption[]>;
  setCleanMode: (
    value: number,
    agent: Agent,
  ) => ReturnType<ValueSetter<number>> | undefined;
}

export interface RvcCleanModeServerInitialState {
  supportedModes: RvcCleanMode.ModeOption[];
  currentMode: number;
}

// biome-ignore lint/correctness/noUnusedVariables: Used by RvcCleanModeServer function
class RvcCleanModeServerBase extends Base {
  declare state: RvcCleanModeServerBase.State;
  declare internal: RvcCleanModeServerBase.Internal;

  private static readonly PENDING_MODE_TIMEOUT_MS = 10000;

  override async initialize() {
    clampCurrentMode(this.state, this.state.supportedModes[0]?.mode ?? 0);
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    // offline: true so reactor writes commit independently and emit
    // subscription reports, matching the sibling RVC behaviors.
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
      return;
    }
    const reportedMode = this.state.config.getCurrentMode(
      entity.state,
      this.agent,
    );

    let currentMode = reportedMode;
    const internal = this.internal;
    if (internal.pendingMode !== undefined) {
      const elapsed = Date.now() - internal.pendingModeTimestamp;
      if (
        reportedMode === internal.pendingMode ||
        elapsed > RvcCleanModeServerBase.PENDING_MODE_TIMEOUT_MS
      ) {
        internal.pendingMode = undefined;
      } else {
        currentMode = internal.pendingMode;
      }
    }
    currentMode ??= this.state.currentMode;

    const supportedModes = withTwoModes(
      this.state.config.getSupportedModes(entity.state, this.agent),
    );
    // matter.js throws on a mode outside the list, which fails the endpoint.
    if (!supportedModes.some((m) => m.mode === currentMode)) {
      if (internal.unsupportedMode !== currentMode) {
        internal.unsupportedMode = currentMode;
        logger.warn(
          `${entity.entity_id}: mode ${currentMode} is not supported, ` +
            `using ${supportedModes[0].mode}`,
        );
      }
      currentMode = supportedModes[0].mode;
    } else {
      internal.unsupportedMode = undefined;
    }

    applyPatchState(
      this.state,
      { currentMode, supportedModes },
      { force: true },
    );
  }

  override changeToMode(
    request: ModeBase.ChangeToModeRequest,
  ): ModeBase.ChangeToModeResponse {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const { newMode } = request;

    // Validate mode exists in supportedModes (matches matter.js base behavior)
    if (
      newMode !== this.state.currentMode &&
      !this.state.supportedModes.some((m) => m.mode === newMode)
    ) {
      logger.warn(`changeToMode(${newMode}) rejected: unsupported mode`);
      return {
        status: ModeBase.ModeChangeStatus.UnsupportedMode,
        statusText: `Unsupported mode: ${newMode}`,
      };
    }

    if (newMode === PLACEHOLDER_MODE.mode) {
      return {
        status: ModeBase.ModeChangeStatus.GenericFailure,
        statusText: "Not supported by this vacuum",
      };
    }

    const modeLabel = this.state.supportedModes.find((m) => m.mode === newMode);
    logger.info(
      `changeToMode(${newMode}) "${modeLabel?.label ?? "unknown"}" ` +
        `for ${homeAssistant.entityId}`,
    );

    this.state.currentMode = newMode;

    const action = this.state.config.setCleanMode(newMode, this.agent);
    if (action) {
      // Nothing sent means no HA update will confirm it, so do not hold it.
      this.internal.pendingMode = newMode;
      this.internal.pendingModeTimestamp = Date.now();
      logger.info(
        `changeToMode: dispatching action ${action.action} → ${action.target ?? homeAssistant.entityId}`,
      );
      homeAssistant.callAction(action);
    } else {
      this.internal.pendingMode = undefined;
    }

    return {
      status: ModeBase.ModeChangeStatus.Success,
      statusText: "Cleaning mode changed",
    };
  }
}

namespace RvcCleanModeServerBase {
  // Behavior instances are per transaction, so the pending mode lives in
  // internal state. It keeps stale HA state (for example from a select
  // entity) from overwriting the mode before HA confirms the change.
  export class Internal extends Base.Internal {
    pendingMode?: number;
    pendingModeTimestamp = 0;
    unsupportedMode?: number;
  }
  export class State extends Base.State {
    config!: RvcCleanModeServerConfig;
  }
}

/**
 * Create an RvcCleanMode behavior with initial state.
 * Used for vacuum cleaning modes (vacuum, mop, vacuum+mop, etc.)
 */
export function RvcCleanModeServer(
  config: RvcCleanModeServerConfig,
  initialState?: RvcCleanModeServerInitialState,
) {
  const defaultModes: RvcCleanMode.ModeOption[] = [
    {
      label: "Vacuum",
      mode: 0,
      modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }],
    },
  ];

  return RvcCleanModeServerBase.set({
    config,
    supportedModes: withTwoModes(initialState?.supportedModes ?? defaultModes),
    currentMode: initialState?.currentMode ?? 0,
  });
}
