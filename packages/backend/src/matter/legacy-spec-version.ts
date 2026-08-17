import type { BridgeFeatureFlags } from "@home-assistant-matter-hub/common";
import { Specification } from "@matter/main/model";
import type { SessionManager } from "@matter/main/protocol";

// Matter 1.5.1, the last revision this bridge advertised up to v2.0.49 and
// the last with a confirmed Echo pairing. Diagnostic for #449.
export const SPEC_VERSION_1_5_1 = 0x01050100;
export const DATA_MODEL_REVISION_19 = 19;

export function specVersionValues(flags?: BridgeFeatureFlags) {
  return flags?.advertiseSpecVersion151
    ? {
        specificationVersion: SPEC_VERSION_1_5_1,
        dataModelRevision: DATA_MODEL_REVISION_19,
      }
    : {
        specificationVersion: Specification.SPECIFICATION_VERSION,
        dataModelRevision: Specification.DATA_MODEL_REVISION,
      };
}

export function legacySpecBasicInformation(flags?: BridgeFeatureFlags) {
  if (!flags?.advertiseSpecVersion151) return {};
  return specVersionValues(flags);
}

// The node announces the same pair in its session parameters during PASE, so
// the attribute mask alone would be inconsistent. Always set both directions:
// a node kept across a flag change must not stay stuck on the old values.
export function applyLegacySpecSessionParameters(
  sessionManager: SessionManager,
  flags?: BridgeFeatureFlags,
) {
  sessionManager.sessionParameters = specVersionValues(flags);
}
