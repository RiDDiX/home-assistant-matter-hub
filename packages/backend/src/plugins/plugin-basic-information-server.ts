import crypto from "node:crypto";
import { VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors";
import { BridgeDataProvider } from "../services/bridges/bridge-data-provider.js";
import { applyPatchState } from "../utils/apply-patch-state.js";
import { PluginDeviceBehavior } from "./plugin-behavior.js";

/**
 * BridgedDeviceBasicInformation for plugin-provided endpoints.
 * Uses PluginDeviceBehavior instead of HomeAssistantEntityBehavior.
 */
export class PluginBasicInformationServer extends BridgedDeviceBasicInformationServer {
  override async initialize(): Promise<void> {
    await super.initialize();
    const pluginDevice = this.agent.get(PluginDeviceBehavior);
    const device = pluginDevice.device;
    const { basicInformation } = this.env.get(BridgeDataProvider);
    applyPatchState(this.state, {
      vendorId: VendorId(basicInformation.vendorId),
      vendorName: truncate(32, pluginDevice.pluginName),
      productName: truncate(32, device.deviceType ?? device.name),
      nodeLabel: truncate(32, device.name),
      serialNumber: crypto
        .createHash("md5")
        .update(`plugin_${device.id}`)
        .digest("hex")
        .substring(0, 32),
      uniqueId: crypto
        .createHash("md5")
        .update(`plugin_${device.id}`)
        .digest("hex")
        .substring(0, 32),
      reachable: true,
    });
  }
}

function truncate(maxLength: number, value: string): string {
  if (value.length <= maxLength) return value;
  return `${value.substring(0, maxLength - 3)}...`;
}
