import type { TFunction } from "i18next";

// Status reasons come from the backend as fixed English text. Known ones are
// translated, the error detail after a known prefix is kept as is.
const known: Record<string, string> = {
  "Manually stopped": "bridgeUi.manuallyStopped",
  "Factory reset": "bridgeUi.factoryReset",
  "The bridge is starting... Please wait.": "bridgeUi.starting",
  "The server mode bridge is starting... Please wait.":
    "bridgeUi.serverModeStarting",
};

const prefixes: [string, string][] = [
  ["Failed to start bridge due to error:", "bridgeUi.startFailed"],
  ["Failed to update bridge due to error:", "bridgeUi.updateFailed"],
  [
    "Failed to start server mode bridge due to error:",
    "bridgeUi.serverModeStartFailed",
  ],
  [
    "Failed to update server mode bridge due to error:",
    "bridgeUi.serverModeUpdateFailed",
  ],
];

export function bridgeStatusMessage(reason: string, t: TFunction): string {
  const key = known[reason];
  if (key) return t(key);
  for (const [prefix, k] of prefixes) {
    if (reason.startsWith(prefix)) {
      return t(k, { error: reason.slice(prefix.length).trim() });
    }
  }
  return reason;
}
