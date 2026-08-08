/**
 * Mock Cloud Provider Plugin
 *
 * Demonstrates how to build a device source plugin that integrates
 * an external cloud service with HAMH. Uses an in-memory mock API
 * for testing, replace MockCloudApi with your real provider's SDK.
 *
 * Features demonstrated:
 *   - Device discovery from external source
 *   - Periodic polling for state changes
 *   - Forwarding controller commands to cloud API
 *   - Safe token storage (never logged)
 *   - Config schema for UI settings
 */

// ---- Mock Cloud API (replace with real provider SDK) ----

class MockCloudApi {
  #devices = new Map();
  #pollTimer;

  constructor() {
    this.#devices.set("cloud-light-1", {
      id: "cloud-light-1",
      type: "light",
      name: "Cloud Living Room Light",
      state: { on: false },
    });
    this.#devices.set("cloud-sensor-1", {
      id: "cloud-sensor-1",
      type: "temperature",
      name: "Cloud Kitchen Temp",
      state: { temperature: 21.5 },
    });
    this.#devices.set("cloud-contact-1", {
      id: "cloud-contact-1",
      type: "contact",
      name: "Cloud Front Door",
      state: { open: false },
    });
    this.#devices.set("cloud-lock-1", {
      id: "cloud-lock-1",
      type: "lock",
      name: "Cloud Main Lock",
      state: { locked: true },
    });
  }

  async authenticate(token) {
    if (!token || token.length < 1) {
      throw new Error("Invalid API token");
    }
    return true;
  }

  async discoverDevices() {
    return Array.from(this.#devices.values()).map((d) => ({
      id: d.id,
      type: d.type,
      name: d.name,
    }));
  }

  async getDeviceState(deviceId) {
    const device = this.#devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);
    return { ...device.state };
  }

  async sendCommand(deviceId, command, _value) {
    const device = this.#devices.get(deviceId);
    if (!device) throw new Error(`Device ${deviceId} not found`);

    switch (command) {
      case "turn_on":
        device.state.on = true;
        break;
      case "turn_off":
        device.state.on = false;
        break;
      case "lock":
        device.state.locked = true;
        break;
      case "unlock":
        device.state.locked = false;
        break;
    }
  }

  startPolling(intervalMs, callback) {
    this.#pollTimer = setInterval(async () => {
      for (const [id, device] of this.#devices) {
        callback(id, { ...device.state });
      }
    }, intervalMs);
  }

  stopPolling() {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
  }
}

// ---- Cloud device type to Matter device type mapping ----

const DEVICE_TYPE_MAP = {
  light: "on_off_light",
  temperature: "temperature_sensor",
  contact: "contact_sensor",
  lock: "door_lock",
};

function cloudStateToMatterClusters(type, cloudState) {
  switch (type) {
    case "light":
      return [
        { clusterId: "onOff", attributes: { onOff: cloudState.on ?? false } },
      ];
    case "temperature":
      return [
        {
          clusterId: "temperatureMeasurement",
          attributes: {
            measuredValue: Math.round((cloudState.temperature ?? 20) * 100),
          },
        },
      ];
    case "contact":
      return [
        {
          clusterId: "booleanState",
          attributes: { stateValue: !(cloudState.open ?? false) },
        },
      ];
    case "lock":
      return [
        {
          clusterId: "doorLock",
          attributes: { lockState: cloudState.locked ? 1 : 2 },
        },
      ];
    default:
      return [];
  }
}

// ---- Plugin Implementation ----

export default class CloudMockPlugin {
  name = "hamh-plugin-cloud-mock";
  version = "1.0.0";

  /** @type {import("../hamh-plugin-example/types").PluginContext | undefined} */
  #context;
  #api;
  #deviceMap = new Map();
  #pollInterval;

  async onStart(context) {
    this.#context = context;
    this.#api = new MockCloudApi();
    this.#pollInterval = (await context.storage.get("pollInterval")) ?? 30_000;

    // Retrieve stored token (never log tokens)
    let token = await context.storage.get("apiToken");
    if (!token) {
      token = "mock-token";
      await context.storage.set("apiToken", token);
    }

    try {
      await this.#api.authenticate(token);
    } catch (_err) {
      context.log.error("Authentication failed");
      return;
    }

    const cloudDevices = await this.#api.discoverDevices();
    context.log.info(`Discovered ${cloudDevices.length} cloud devices`);

    for (const cd of cloudDevices) {
      const matterType = DEVICE_TYPE_MAP[cd.type];
      if (!matterType) {
        context.log.warn(`Unsupported cloud device type: ${cd.type}`);
        continue;
      }

      const state = await this.#api.getDeviceState(cd.id);
      const clusters = cloudStateToMatterClusters(cd.type, state);
      this.#deviceMap.set(cd.id, { type: cd.type, name: cd.name });

      await context.registerDevice({
        id: cd.id,
        name: cd.name,
        deviceType: matterType,
        clusters,
        onAttributeWrite: async (clusterId, attribute, value) => {
          await this.#handleWrite(cd.id, cd.type, clusterId, attribute, value);
        },
      });
    }

    // Poll for state changes
    this.#api.startPolling(this.#pollInterval, (deviceId, cloudState) => {
      const info = this.#deviceMap.get(deviceId);
      if (!info) return;
      const clusters = cloudStateToMatterClusters(info.type, cloudState);
      for (const cluster of clusters) {
        context.updateDeviceState(
          deviceId,
          cluster.clusterId,
          cluster.attributes,
        );
      }
    });

    context.log.info("Cloud mock plugin started");
  }

  async #handleWrite(deviceId, deviceType, clusterId, attribute, value) {
    try {
      if (
        deviceType === "light" &&
        clusterId === "onOff" &&
        attribute === "onOff"
      ) {
        await this.#api.sendCommand(deviceId, value ? "turn_on" : "turn_off");
      } else if (
        deviceType === "lock" &&
        clusterId === "doorLock" &&
        attribute === "lockState"
      ) {
        await this.#api.sendCommand(deviceId, value === 1 ? "lock" : "unlock");
      }
    } catch (_err) {
      this.#context?.log.error(`Command failed for ${deviceId}`);
    }
  }

  getConfigSchema() {
    return {
      title: "Mock Cloud Provider",
      properties: {
        pollInterval: {
          type: "number",
          title: "Polling Interval (ms)",
          default: 30000,
        },
        apiToken: {
          type: "string",
          title: "API Token",
        },
      },
    };
  }

  async onConfigChanged(config) {
    if (config.pollInterval) {
      this.#pollInterval = config.pollInterval;
      await this.#context?.storage.set("pollInterval", config.pollInterval);
    }
    if (config.apiToken) {
      await this.#context?.storage.set("apiToken", config.apiToken);
    }
  }

  async onShutdown() {
    this.#api?.stopPolling();
    this.#context?.log.info("Cloud mock plugin shut down");
  }
}
