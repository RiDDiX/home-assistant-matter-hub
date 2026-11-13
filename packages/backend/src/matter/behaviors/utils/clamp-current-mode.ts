// A stored currentMode wins over the seed; if it left supportedModes matter.js
// fails the endpoint in initialize(), so call this before super.initialize().
export function clampCurrentMode(
  state: { supportedModes: readonly { mode: number }[]; currentMode: number },
  fallback: number,
) {
  if (!state.supportedModes.some((m) => m.mode === state.currentMode)) {
    state.currentMode = fallback;
  }
}
