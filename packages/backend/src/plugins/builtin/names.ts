// Plugin names as the UI shows them, e.g. "camera". These are not npm package
// names, so installing one pulls an unrelated stranger off the registry (#432).
// Kept free of plugin imports so the API does not drag the camera stack in;
// builtin-names.test.ts pins the list against the real plugin classes.
export const BUILTIN_PLUGIN_NAMES: readonly string[] = ["camera", "security"];
