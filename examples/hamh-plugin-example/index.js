/**
 * Example HAMH Plugin, Virtual Temperature Sensor
 *
 * Registers a virtual temperature sensor on the bridge and simulates
 * periodic temperature changes. Use as a starting point for your own plugins.
 *
 * Supported device types:
 *   on_off_light, dimmable_light, color_temperature_light, extended_color_light,
 *   on_off_plugin_unit, dimmable_plug_in_unit, temperature_sensor,
 *   humidity_sensor, pressure_sensor, flow_sensor, light_sensor,
 *   occupancy_sensor, contact_sensor, air_quality_sensor, thermostat,
 *   door_lock, fan, window_covering, generic_switch, water_leak_detector
 */

export default class ExamplePlugin {
  name = "hamh-plugin-example";
  version = "1.0.0";

  /** @type {import("./types").PluginContext | undefined} */
  #context;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #interval;

  /** @param {import("./types").PluginContext} context */
  async onStart(context) {
    this.#context = context;
    context.log.info("Example plugin starting...");

    await context.registerDevice({
      id: "example-temp-1",
      name: "Example Temperature",
      deviceType: "temperature_sensor",
      clusters: [
        {
          clusterId: "temperatureMeasurement",
          attributes: { measuredValue: 2150 }, // 21.50 °C (Matter uses 0.01 °C units)
        },
      ],
      onAttributeWrite: async (clusterId, attribute, value) => {
        context.log.info(
          `Attribute write: ${clusterId}.${attribute} = ${JSON.stringify(value)}`,
        );
      },
    });

    // Simulate temperature changes every 30 seconds
    this.#interval = setInterval(() => {
      const temp = 2000 + Math.round(Math.random() * 500); // 20.00-25.00 °C
      context.updateDeviceState("example-temp-1", "temperatureMeasurement", {
        measuredValue: temp,
      });
    }, 30_000);

    context.log.info("Example plugin started");
  }

  async onConfigure() {
    const lastTemp = await this.#context?.storage.get("lastTemp");
    if (lastTemp != null) {
      this.#context?.updateDeviceState(
        "example-temp-1",
        "temperatureMeasurement",
        { measuredValue: lastTemp },
      );
    }
  }

  async onShutdown() {
    if (this.#interval) clearInterval(this.#interval);
    this.#context?.log.info("Example plugin shut down");
  }
}
