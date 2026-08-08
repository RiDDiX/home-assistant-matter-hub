/**
 * Intentionally Broken Plugin, for testing HAMH failure isolation.
 *
 * Exercises multiple failure modes to verify that HAMH continues
 * running when a plugin misbehaves. Configure via the `failMode`
 * config option.
 *
 * DO NOT use this as a template for real plugins.
 */

export default class BrokenPlugin {
  name = "hamh-plugin-broken";
  version = "1.0.0";

  #failMode;

  constructor(config) {
    this.#failMode = config?.failMode ?? "throw_on_start";
  }

  async onStart(context) {
    switch (this.#failMode) {
      case "throw_on_start":
        throw new Error("Intentional crash in onStart");

      case "invalid_device":
        await context.registerDevice({
          id: "bad-device",
          name: "Bad Device",
          deviceType: "nonexistent_type_xyz",
          clusters: [],
        });
        break;

      case "empty_id":
        await context.registerDevice({
          id: "",
          name: "Empty ID Device",
          deviceType: "on_off_light",
          clusters: [],
        });
        break;

      case "hang_on_start":
        await new Promise(() => {});
        break;

      case "normal_start_bad_configure":
        await context.registerDevice({
          id: "ok-device",
          name: "OK Device",
          deviceType: "on_off_light",
          clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        });
        break;

      case "fire_and_forget":
        setTimeout(() => {
          Promise.reject(new Error("Fire-and-forget rejection from plugin"));
        }, 100);
        await context.registerDevice({
          id: "ff-device",
          name: "FF Device",
          deviceType: "on_off_light",
          clusters: [{ clusterId: "onOff", attributes: { onOff: false } }],
        });
        break;

      default:
        context.log.info(`Unknown fail mode: ${this.#failMode}`);
    }
  }

  async onConfigure() {
    if (this.#failMode === "normal_start_bad_configure") {
      throw new Error("Intentional crash in onConfigure");
    }
    if (this.#failMode === "hang_on_configure") {
      await new Promise(() => {});
    }
  }

  async onShutdown() {
    // May or may not be called depending on failure mode
  }
}
