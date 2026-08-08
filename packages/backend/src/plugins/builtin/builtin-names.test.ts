import { describe, expect, it } from "vitest";
import { BUILTIN_PLUGINS } from "./index.js";
import { BUILTIN_PLUGIN_NAMES } from "./names.js";

// The install guard reads the plain name list so the API stays free of plugin
// imports. This is the drift guard: adding a built-in plugin without listing
// its name would reopen the #432 hole silently.
describe("builtin plugin names", () => {
  it("matches the names of the registered built-in plugins", () => {
    const actual = BUILTIN_PLUGINS.map((Plugin) => new Plugin().name).sort();
    expect(actual).toEqual([...BUILTIN_PLUGIN_NAMES].sort());
  });
});
