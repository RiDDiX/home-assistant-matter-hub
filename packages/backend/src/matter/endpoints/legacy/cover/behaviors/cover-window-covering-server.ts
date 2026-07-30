import {
  type CoverDeviceAttributes,
  CoverDeviceState,
  CoverSupportedFeatures,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Agent } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { BridgeDataProvider } from "../../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  type WindowCoveringConfig,
  WindowCoveringServer,
} from "../../../../behaviors/window-covering-server.js";
import {
  adjustPositionForReading as adjustReading,
  adjustPositionForWriting as adjustWriting,
} from "./cover-position-utils.js";

const logger = Logger.get("CoverWindowCoveringServer");

const attributes = (entity: HomeAssistantEntityState) =>
  <CoverDeviceAttributes>entity.attributes;

// HA cover device_class -> Matter WindowCovering Type + EndProductType.
// Google Home and friends use these attributes for voice intents like
// "open curtains"; without this map every cover looks like a roller shade
// regardless of what it actually is (#304).
export const DEVICE_CLASS_TO_MATTER_TYPE: Record<
  string,
  {
    type: WindowCovering.WindowCoveringType;
    endProductType: WindowCovering.EndProductType;
  }
> = {
  curtain: {
    type: WindowCovering.WindowCoveringType.Drapery,
    endProductType: WindowCovering.EndProductType.CentralCurtain,
  },
  awning: {
    type: WindowCovering.WindowCoveringType.Awning,
    endProductType: WindowCovering.EndProductType.AwningTerracePatio,
  },
  shutter: {
    type: WindowCovering.WindowCoveringType.Shutter,
    endProductType: WindowCovering.EndProductType.RollerShutter,
  },
  blind: {
    type: WindowCovering.WindowCoveringType.TiltBlindTiltOnly,
    endProductType: WindowCovering.EndProductType.InteriorBlind,
  },
  shade: {
    type: WindowCovering.WindowCoveringType.Rollershade,
    endProductType: WindowCovering.EndProductType.RollerShade,
  },
  // Velux-style motorized roof/casement windows. No Matter WindowCoveringType
  // for "window", so map to Rollershade + RollerShade (the spec default pair).
  // EndProductType is a FixedAttribute, and Alexa's routine picker drops
  // devices it can't categorize - Unknown (255) lands there (#312).
  window: {
    type: WindowCovering.WindowCoveringType.Rollershade,
    endProductType: WindowCovering.EndProductType.RollerShade,
  },
};

export const deviceClassMapping = (entity: HomeAssistantEntityState) => {
  const raw = (entity.attributes as Record<string, unknown>).device_class;
  if (typeof raw !== "string") return undefined;
  const mapping = DEVICE_CLASS_TO_MATTER_TYPE[raw.toLowerCase()];
  if (!mapping) return undefined;

  // TiltBlindTiltOnly only fits tilt-only covers: fall back to Rollershade
  // for lift-only blinds (#312) and TiltBlindLift for lift+tilt (#323).
  const supportedFeatures = attributes(entity).supported_features ?? 0;
  const hasLift =
    (supportedFeatures & CoverSupportedFeatures.support_open) !== 0;
  const hasTilt = coverHasTilt(supportedFeatures);
  if (mapping.type === WindowCovering.WindowCoveringType.TiltBlindTiltOnly) {
    if (!hasTilt) {
      return {
        type: WindowCovering.WindowCoveringType.Rollershade,
        endProductType: mapping.endProductType,
      };
    }
    if (hasLift) {
      return {
        type: WindowCovering.WindowCoveringType.TiltBlindLift,
        endProductType: mapping.endProductType,
      };
    }
  }
  return mapping;
};

/**
 * Platforms known to use Matter-compatible position semantics (0=open, 100=closed).
 * These integrations report position as "% closed" which matches Matter's expectations.
 * NOTE: Overkiz/Somfy was removed - it uses standard HA semantics (0=closed, 100=open).
 * See GitHub Issue #90.
 */
const MATTER_SEMANTIC_PLATFORMS: string[] = [
  // Currently empty - no known platforms use Matter semantics by default
  // Add platforms here only if confirmed to use 0=open, 100=closed
];

/**
 * Checks if the entity uses Matter-compatible position semantics (0=open, 100=closed).
 * Currently no platforms are known to use this by default.
 */
const usesMatterSemantics = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const platform = homeAssistant.entity.registry?.platform?.toLowerCase();
  if (platform && MATTER_SEMANTIC_PLATFORMS.includes(platform)) {
    return true;
  }
  return false;
};

/**
 * Adjusts position when READING from HA to report to Matter controllers.
 * Delegates to the pure utility function for testability.
 */
const adjustPositionForReading = (position: number, agent: Agent) => {
  const { featureFlags } = agent.env.get(BridgeDataProvider);
  const matterSem = usesMatterSemantics(agent);
  const result = adjustReading(position, featureFlags, matterSem);
  logger.debug(`adjustPositionForReading: HA=${position}%, result=${result}%`);
  return result;
};

/**
 * Adjusts position when WRITING to HA from Matter controller commands.
 * Delegates to the pure utility function for testability.
 */
const adjustPositionForWriting = (position: number, agent: Agent) => {
  const { featureFlags } = agent.env.get(BridgeDataProvider);
  const matterSem = usesMatterSemantics(agent);
  return adjustWriting(position, featureFlags, matterSem);
};

/**
 * Where the position attributes land once HA parks the cover at an end. Runs the
 * HA end value (open = 100, closed = 0) through the same read conversion the
 * getters below use, so no inversion rule is duplicated: default flags turn HA
 * open into Matter 0, while coverUseHomeAssistantPercentage /
 * coverDoNotInvertPercentage keep it at 100. Axis-independent because lift and
 * tilt share adjustPositionForReading (#429).
 */
const expectedRestPosition = (end: "open" | "close", agent: Agent) =>
  adjustPositionForReading(end === "open" ? 100 : 0, agent);

/**
 * Checks if open/close commands should be swapped.
 * Per-entity mapping overrides the bridge-level feature flag.
 */
const shouldSwapOpenClose = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const entitySwap = homeAssistant.state.mapping?.coverSwapOpenClose;
  if (entitySwap !== undefined) return entitySwap;
  const { featureFlags } = agent.env.get(BridgeDataProvider);
  return featureFlags?.coverSwapOpenClose === true;
};

/**
 * Checks if the cover supports position control (support_set_position feature).
 */
const supportsPositionControl = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const supportedFeatures =
    attributes(homeAssistant.entity.state).supported_features ?? 0;
  return (
    (supportedFeatures & CoverSupportedFeatures.support_set_position) !== 0
  );
};

/**
 * Checks if the cover supports tilt position control (support_set_tilt_position feature).
 */
const supportsTiltPositionControl = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const supportedFeatures =
    attributes(homeAssistant.entity.state).supported_features ?? 0;
  return (
    (supportedFeatures & CoverSupportedFeatures.support_set_tilt_position) !== 0
  );
};

// Tilt if the cover reports open_tilt or set_tilt_position. Gating on open_tilt
// alone dropped tilt for set-tilt-position-only covers on every controller (#405).
export const coverHasTilt = (supportedFeatures: number): boolean =>
  (supportedFeatures & CoverSupportedFeatures.support_open_tilt) !== 0 ||
  (supportedFeatures & CoverSupportedFeatures.support_set_tilt_position) !== 0;

// True only when the cover has the discrete open/close tilt services (#405).
const supportsOpenCloseTilt = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const supportedFeatures =
    attributes(homeAssistant.entity.state).supported_features ?? 0;
  return (supportedFeatures & CoverSupportedFeatures.support_open_tilt) !== 0;
};

/**
 * Tilt-only covers (e.g. SwitchBot Blind Tilt, supported_features=240)
 * expose no support_open, so HA rejects cover.open_cover and
 * cover.set_cover_position (#350). When the entity has tilt, Lift
 * commands from controllers must be routed to the tilt services (tilt =
 * open_tilt or set_tilt_position, #405).
 */
export const liftShouldUseTilt = (supportedFeatures: number): boolean =>
  (supportedFeatures & CoverSupportedFeatures.support_open) === 0 &&
  coverHasTilt(supportedFeatures);

const liftFallsBackToTilt = (agent: Agent): boolean => {
  const homeAssistant = agent.get(HomeAssistantEntityBehavior);
  const supportedFeatures =
    attributes(homeAssistant.entity.state).supported_features ?? 0;
  return liftShouldUseTilt(supportedFeatures);
};

const openLiftAction = (agent: Agent) => ({
  action: shouldSwapOpenClose(agent) ? "cover.close_cover" : "cover.open_cover",
});

const closeLiftAction = (agent: Agent) => ({
  action: shouldSwapOpenClose(agent) ? "cover.open_cover" : "cover.close_cover",
});

const setTiltPositionAction = (position: number, agent: Agent) => {
  // For binary tilt covers (no tilt position support), translate to open/close tilt
  if (!supportsTiltPositionControl(agent)) {
    const adjustedPosition = adjustPositionForWriting(position, agent);
    const shouldOpen = adjustedPosition != null && adjustedPosition >= 50;
    const swapped = shouldSwapOpenClose(agent);
    if (shouldOpen) {
      return {
        action: swapped ? "cover.close_cover_tilt" : "cover.open_cover_tilt",
      };
    }
    return {
      action: swapped ? "cover.open_cover_tilt" : "cover.close_cover_tilt",
    };
  }
  return {
    action: "cover.set_cover_tilt_position",
    data: { tilt_position: adjustPositionForWriting(position, agent) },
  };
};

// Covers with open_tilt use the dedicated services; a set-tilt-position-only
// cover has none, so tilt open/close falls back to set_cover_tilt_position at
// the fully open (0) / closed (100) value, invert applied like the slider (#405).
const openTiltAction = (agent: Agent) => {
  if (!supportsOpenCloseTilt(agent)) {
    return setTiltPositionAction(0, agent);
  }
  return {
    action: shouldSwapOpenClose(agent)
      ? "cover.close_cover_tilt"
      : "cover.open_cover_tilt",
  };
};

const closeTiltAction = (agent: Agent) => {
  if (!supportsOpenCloseTilt(agent)) {
    return setTiltPositionAction(100, agent);
  }
  return {
    action: shouldSwapOpenClose(agent)
      ? "cover.open_cover_tilt"
      : "cover.close_cover_tilt",
  };
};

const config: WindowCoveringConfig = {
  getCurrentLiftPosition: (entity, agent) => {
    let position = attributes(entity).current_position;
    if (position == null) {
      const coverState = entity.state as CoverDeviceState;
      // HA semantics: 0=closed, 100=open
      position =
        coverState === CoverDeviceState.closed
          ? 0
          : coverState === CoverDeviceState.open
            ? 100
            : undefined;
    }
    return position == null ? null : adjustPositionForReading(position, agent);
  },
  getCurrentTiltPosition: (entity, agent) => {
    let position = attributes(entity).current_tilt_position;
    if (position == null) {
      const coverState = entity.state as CoverDeviceState;
      // HA semantics: 0=closed, 100=open
      position =
        coverState === CoverDeviceState.closed
          ? 0
          : coverState === CoverDeviceState.open
            ? 100
            : undefined;
    }
    return position == null ? null : adjustPositionForReading(position, agent);
  },
  getExpectedRestPosition: expectedRestPosition,
  getCoverType: (entity) => deviceClassMapping(entity)?.type,
  getEndProductType: (entity) => deviceClassMapping(entity)?.endProductType,
  getMovementStatus: (entity, agent) => {
    // Same resolution the dispatch side uses, per-entity mapping first. Reading
    // only the bridge flag made a per-entity swap report HA "opening" as Matter
    // Opening while the command had written Closing, so the controller watched
    // the direction flip mid-move (#429).
    const swapped = shouldSwapOpenClose(agent);
    const coverState = entity.state as CoverDeviceState;
    if (coverState === CoverDeviceState.opening) {
      return swapped
        ? WindowCovering.MovementStatus.Closing
        : WindowCovering.MovementStatus.Opening;
    }
    if (coverState === CoverDeviceState.closing) {
      return swapped
        ? WindowCovering.MovementStatus.Opening
        : WindowCovering.MovementStatus.Closing;
    }
    return WindowCovering.MovementStatus.Stopped;
  },

  stopCover: () => ({ action: "cover.stop_cover" }),

  // Open/close can be swapped via coverSwapOpenClose flag for Alexa
  // compatibility. Tilt-only covers route Lift commands to tilt (#350).
  openCoverLift: (_, agent) =>
    liftFallsBackToTilt(agent) ? openTiltAction(agent) : openLiftAction(agent),
  closeCoverLift: (_, agent) =>
    liftFallsBackToTilt(agent)
      ? closeTiltAction(agent)
      : closeLiftAction(agent),
  setLiftPosition: (position, agent) => {
    // Tilt-only cover: HA rejects cover.set_cover_position, use tilt (#350)
    if (liftFallsBackToTilt(agent)) {
      return setTiltPositionAction(position, agent);
    }
    // For binary covers (no position support), translate position to open/close
    // Matter position: 0=open, 100=closed (after inversion from HA semantics)
    if (!supportsPositionControl(agent)) {
      const adjustedPosition = adjustPositionForWriting(position, agent);
      // HA semantics: 0=closed, 100=open
      // If adjusted position < 50, cover should be more closed → close
      // If adjusted position >= 50, cover should be more open → open
      const shouldOpen = adjustedPosition != null && adjustedPosition >= 50;
      const swapped = shouldSwapOpenClose(agent);
      if (shouldOpen) {
        return { action: swapped ? "cover.close_cover" : "cover.open_cover" };
      }
      return { action: swapped ? "cover.open_cover" : "cover.close_cover" };
    }
    return {
      action: "cover.set_cover_position",
      data: { position: adjustPositionForWriting(position, agent) },
    };
  },

  // Tilt open/close also respects the swap flag
  openCoverTilt: (_, agent) => openTiltAction(agent),
  closeCoverTilt: (_, agent) => closeTiltAction(agent),
  setTiltPosition: (position, agent) => setTiltPositionAction(position, agent),
};

export const CoverWindowCoveringServer = WindowCoveringServer(config);
