import type { StandaloneDeviceData } from "@home-assistant-matter-hub/common/src/standalone-device-data.js";
import type { Environment } from "@matter/main";
import { Endpoint } from "@matter/main";
import { IdentifyServer } from "@matter/main/behaviors";
import {
  DimmableLightDevice,
  HumiditySensorDevice,
  OnOffLightDevice,
  TemperatureSensorDevice,
  ThermostatDevice,
} from "@matter/main/devices";
import { ServerModeServerNode } from "../../matter/endpoints/server-mode-server-node.js";
import { validateEndpointType } from "../../matter/endpoints/validate-endpoint-type.js";
import type { StandaloneDeviceStorage } from "../storage/standalone-device-storage.js";

export class StandaloneDeviceManager {
  private devices: Map<string, ServerModeServerNode> = new Map();
  private storage: StandaloneDeviceStorage;
  private env: Environment;

  constructor(env: Environment, storage: StandaloneDeviceStorage) {
    this.env = env;
    this.storage = storage;
  }

  async initialize() {
    // Load all devices from storage and instantiate Matter nodes
    for (const deviceData of this.storage.devices) {
      await this.addDevice(deviceData, false);
    }
  }

  getDeviceClass(type: string) {
    switch (type) {
      case "light":
        return OnOffLightDevice;
      case "dimmable-light":
        return DimmableLightDevice;
      case "thermostat":
        return ThermostatDevice;
      case "temperature-sensor":
        return TemperatureSensorDevice;
      case "humidity-sensor":
        return HumiditySensorDevice;
      default:
        return OnOffLightDevice;
    }
  }

  async addDevice(deviceData: StandaloneDeviceData, persist = true) {
    // Map deviceType to Matter device class
    const DeviceClass = this.getDeviceClass(deviceData.deviceType);
    // Compose with IdentifyServer for best compatibility
    const deviceType = DeviceClass.with(IdentifyServer);

    // Attach additional clusters/endpoints for mapped entities
    // (Extend here as needed for more robust mapping)
    // Example: if (deviceData.temperatureEntity) { ... add cluster ... }
    // For now, just log what would be attached
    const extraEntities = [
      "temperatureEntity",
      "humidityEntity",
      "pressureEntity",
      "batteryEntity",
      "powerEntity",
      "energyEntity",
      "suctionLevelEntity",
      "mopIntensityEntity",
      "filterLifeEntity",
      "cleaningModeEntity",
      "roomEntities",
      "disableLockPin",
      "customServiceAreas",
      "customFanSpeedTags",
      "currentRoomEntity",
      "valetudoIdentifier",
      "coverSwapOpenClose",
    ];
    for (const key of extraEntities) {
      if ((deviceData as any)[key]) {
        // In a full implementation, attach the relevant cluster/behavior here
        // For now, just log
        // console.log(`StandaloneDeviceManager: Would attach ${key} to device ${deviceData.id}`);
      }
    }

    // Create endpoint for the main device
    const mainEndpoint = new Endpoint(deviceType, { id: deviceData.id });

    // Validate endpoint type for required clusters
    const validation = validateEndpointType(deviceType, deviceData.id);
    if (validation && validation.missingMandatory.length > 0) {
      // Log or return validation errors
      console.warn(
        `Device ${deviceData.id} missing mandatory clusters: ${validation.missingMandatory.join(", ")}`,
      );
      // Optionally, throw or return error here
    }

    // Create the server node and add the endpoint
    const node = new ServerModeServerNode(this.env, deviceData as any);
    await node.addDevice(mainEndpoint);
    this.devices.set(deviceData.id, node);
    await node.start?.();
    if (persist) {
      await this.storage.add(deviceData);
    }
    return node;
  }

  getDevice(id: string) {
    return this.devices.get(id);
  }

  async removeDevice(id: string) {
    const node = this.devices.get(id);
    if (node) {
      node.factoryReset?.();
      this.devices.delete(id);
      await this.storage.remove(id);
    }
  }

  listDevices() {
    return Array.from(this.devices.values());
  }
}
