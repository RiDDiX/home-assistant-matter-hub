import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { RvcCleanModeServer as Base } from "@matter/main/behaviors";
import { ModeBase } from "@matter/main/clusters/mode-base";
import { RvcCleanMode } from "@matter/main/clusters/rvc-clean-mode";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";
import type { ValueGetter, ValueSetter } from "./utils/cluster-config.js";

const logger = Logger.get("RvcCleanModeServerBase");

export interface RvcCleanModeServerConfig {
  getCurrentMode: ValueGetter<number>;
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

  // Pending mode from a recent changeToMode command.
  // Prevents stale HA state (from a different entity like select.xxx)
  // from overwriting the mode before HA has confirmed the change.
  private pendingMode?: number;
  private pendingModeTimestamp = 0;
  private static readonly PENDING_MODE_TIMEOUT_MS = 10000;

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
    const reportedMode = this.state.config.getCurrentMode(
      entity.state,
      this.agent,
    );

    let currentMode = reportedMode;
    if (this.pendingMode !== undefined) {
      const elapsed = Date.now() - this.pendingModeTimestamp;
      if (
        reportedMode === this.pendingMode ||
        elapsed > RvcCleanModeServerBase.PENDING_MODE_TIMEOUT_MS
      ) {
        this.pendingMode = undefined;
      } else {
        currentMode = this.pendingMode;
      }
    }

    applyPatchState(this.state, {
      currentMode,
      supportedModes: this.state.config.getSupportedModes(
        entity.state,
        this.agent,
      ),
    });
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

    const modeLabel = this.state.supportedModes.find((m) => m.mode === newMode);
    logger.info(
      `changeToMode(${newMode}) "${modeLabel?.label ?? "unknown"}" ` +
        `for ${homeAssistant.entityId}`,
    );

    this.pendingMode = newMode;
    this.pendingModeTimestamp = Date.now();
    this.state.currentMode = newMode;

    const action = this.state.config.setCleanMode(newMode, this.agent);
    if (action) {
      logger.info(
        `changeToMode: dispatching action ${action.action} → ${action.target ?? homeAssistant.entityId}`,
      );
      homeAssistant.callAction(action);
    }

    return {
      status: ModeBase.ModeChangeStatus.Success,
      statusText: "Cleaning mode changed",
    };
  }
}

namespace RvcCleanModeServerBase {
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
    supportedModes: initialState?.supportedModes ?? defaultModes,
    currentMode: initialState?.currentMode ?? 0,
  });
}
