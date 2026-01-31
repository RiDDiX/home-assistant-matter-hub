import {
  type CoverDeviceAttributes,
  CoverDeviceState,
  type HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import type { Agent } from "@matter/main";
import { WindowCovering } from "@matter/main/clusters";
import { BridgeDataProvider } from "../../../../../services/bridges/bridge-data-provider.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import {
  type WindowCoveringConfig,
  WindowCoveringServer,
} from "../../../../behaviors/window-covering-server.js";

const attributes = (entity: HomeAssistantEntityState) =>
  <CoverDeviceAttributes>entity.attributes;

/**
 * Platforms known to use Matter-compatible position semantics (0=open, 100=closed).
 * These integrations report position as "% open" which matches Matter's expectations.
 */
const MATTER_SEMANTIC_PLATFORMS = [
  "overkiz", // Somfy TaHoma, Cozytouch, etc.
  "tahoma", // Legacy Somfy TaHoma integration
  "somfy", // Direct Somfy integration
  "somfy_mylink", // Somfy myLink
];

/**
 * Checks if the entity uses Matter-compatible position semantics (0=open, 100=closed).
 * Some integrations like Overkiz (Somfy TaHoma) use this convention instead of
 * standard HA semantics (0=closed, 100=open).
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
 * By default, inverts percentage (HA 80% open → Matter 20% = 80% closed).
 * With coverUseHomeAssistantPercentage flag, skips inversion for Alexa-friendly display.
 */
const adjustPositionForReading = (position: number, agent: Agent) => {
  const { featureFlags } = agent.env.get(BridgeDataProvider);
  if (position == null) {
    return null;
  }
  let percentValue = position;
  // Skip inversion if:
  // 1. User explicitly set coverDoNotInvertPercentage flag, OR
  // 2. User set coverUseHomeAssistantPercentage for Alexa-friendly display, OR
  // 3. Integration uses Matter-compatible semantics (like Overkiz/Somfy)
  const skipInversion =
    featureFlags?.coverDoNotInvertPercentage === true ||
    featureFlags?.coverUseHomeAssistantPercentage === true ||
    usesMatterSemantics(agent);
  if (!skipInversion) {
    percentValue = 100 - percentValue;
  }
  return percentValue;
};

/**
 * Adjusts position when WRITING to HA from Matter controller commands.
 * By default, inverts percentage (Matter 80% closed → HA 20% open).
 * With coverUseHomeAssistantPercentage, also skips inversion so commands match display.
 */
const adjustPositionForWriting = (position: number, agent: Agent) => {
  const { featureFlags } = agent.env.get(BridgeDataProvider);
  if (position == null) {
    return null;
  }
  let percentValue = position;
  // Skip inversion for writing if:
  // 1. User explicitly set coverDoNotInvertPercentage flag, OR
  // 2. User set coverUseHomeAssistantPercentage (so commands match displayed %), OR
  // 3. Integration uses Matter-compatible semantics (like Overkiz/Somfy)
  const skipInversion =
    featureFlags?.coverDoNotInvertPercentage === true ||
    featureFlags?.coverUseHomeAssistantPercentage === true ||
    usesMatterSemantics(agent);
  if (!skipInversion) {
    percentValue = 100 - percentValue;
  }
  return percentValue;
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
  getMovementStatus: (entity) => {
    const coverState = entity.state as CoverDeviceState;
    return coverState === CoverDeviceState.opening
      ? WindowCovering.MovementStatus.Opening
      : coverState === CoverDeviceState.closing
        ? WindowCovering.MovementStatus.Closing
        : WindowCovering.MovementStatus.Stopped;
  },

  stopCover: () => ({ action: "cover.stop_cover" }),

  openCoverLift: () => ({ action: "cover.open_cover" }),
  closeCoverLift: () => ({ action: "cover.close_cover" }),
  setLiftPosition: (position, agent) => ({
    action: "cover.set_cover_position",
    data: { position: adjustPositionForWriting(position, agent) },
  }),

  openCoverTilt: () => ({ action: "cover.open_cover_tilt" }),
  closeCoverTilt: () => ({ action: "cover.close_cover_tilt" }),
  setTiltPosition: (position, agent) => ({
    action: "cover.set_cover_tilt_position",
    data: { tilt_position: adjustPositionForWriting(position, agent) },
  }),
};

export const CoverWindowCoveringServer = WindowCoveringServer(config);
