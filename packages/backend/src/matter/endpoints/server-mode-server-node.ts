import type {
  BridgeData,
  BridgeFeatureFlags,
  EntityMappingConfig,
  HomeAssistantDeviceRegistry,
} from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import type { Environment } from "@matter/main";
import { RoboticVacuumCleanerDevice } from "@matter/main/devices";
import { type Endpoint, ServerNode } from "@matter/main/node";
import { DeviceTypeId, VendorId } from "@matter/main/types";
import { CAMERA_TCP_CONFIG } from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import { sanitizeMatterString } from "../../utils/sanitize-matter-string.js";
import { trimToLength } from "../../utils/trim-to-length.js";
import { legacySpecBasicInformation } from "../legacy-spec-version.js";
import { matterSubscriptionOptions } from "../subscription-options.js";
import { rootEndpointType } from "../tc-general-commissioning.js";

const logger = Logger.get("ServerModeServerNode");

/**
 * ServerModeServerNode exposes device endpoints directly under the root node.
 * This is different from BridgeServerNode which uses an AggregatorEndpoint.
 *
 * Server Mode is required for Apple Home to properly support Siri voice commands
 * for certain device types like Robot Vacuums (RVC).
 *
 * Device endpoints become children of the root node without the Aggregator
 * wrapper, the Matter composed-device shape. One node can carry several
 * endpoints (#301); identity and the advertised device type come from the
 * primary entity.
 */
export class ServerModeServerNode extends ServerNode {
  private readonly deviceEndpoints = new Map<string, Endpoint>();
  private readonly featureFlags?: BridgeFeatureFlags;
  private readonly serialNumberSuffix?: string;
  // Read by the patched matter.js ServerSubscription when it builds the
  // priming report (#424), see patches/@matter__node@0.17.9.patch.
  hamhOmitEventsInPriming: boolean;

  constructor(env: Environment, bridgeData: BridgeData) {
    super({
      type: rootEndpointType(bridgeData.featureFlags),
      id: bridgeData.id,
      environment: env,
      network: {
        port: bridgeData.port,
        // Shared zero-jitter window, see matterSubscriptionOptions: 60s max so
        // iOS does not show a stale "Updating" tile (#287), no jitter so the
        // keepalive stays inside a controller's ceiling (#386).
        subscriptionOptions: matterSubscriptionOptions(),
        ...(bridgeData.featureFlags?.enableMatterTcp
          ? { tcp: CAMERA_TCP_CONFIG }
          : {}),
      },
      productDescription: {
        name: bridgeData.name,
        deviceType: DeviceTypeId(RoboticVacuumCleanerDevice.deviceType),
      },
      basicInformation: {
        ...legacySpecBasicInformation(bridgeData.featureFlags),
        uniqueId: bridgeData.id,
        nodeLabel: trimToLength(bridgeData.name, 32, "..."),
        vendorId: VendorId(bridgeData.basicInformation.vendorId),
        vendorName: bridgeData.basicInformation.vendorName,
        productId: bridgeData.basicInformation.productId,
        productName: bridgeData.basicInformation.productName,
        productLabel: bridgeData.basicInformation.productLabel,
        serialNumber: `server-${bridgeData.id}`.substring(0, 32),
        hardwareVersion: bridgeData.basicInformation.hardwareVersion,
        softwareVersion: bridgeData.basicInformation.softwareVersion,
        hardwareVersionString:
          bridgeData.basicInformation.hardwareVersionString,
        softwareVersionString:
          bridgeData.basicInformation.softwareVersionString ??
          String(bridgeData.basicInformation.softwareVersion),
        ...(bridgeData.countryCode ? { location: bridgeData.countryCode } : {}),
      },
      subscriptions: {
        persistenceEnabled: false,
      },
    });
    this.featureFlags = bridgeData.featureFlags;
    this.serialNumberSuffix = bridgeData.serialNumberSuffix;
    this.hamhOmitEventsInPriming =
      bridgeData.featureFlags?.omitEventsInPriming === true;
  }

  /** Number of device endpoints currently attached. */
  get deviceCount(): number {
    return this.deviceEndpoints.size;
  }

  /**
   * Add a device endpoint to this server node. Several endpoints per node are
   * supported (#301); the call is idempotent per endpoint id.
   */
  async addDevice(endpoint: Endpoint): Promise<void> {
    if (this.deviceEndpoints.has(endpoint.id)) {
      return;
    }
    this.deviceEndpoints.set(endpoint.id, endpoint);
    await this.add(endpoint);
  }

  /**
   * Drop one device reference after the endpoint has been deleted externally.
   * Must be called before re-adding an endpoint with the same id.
   */
  forgetDevice(endpoint: Endpoint): void {
    this.deviceEndpoints.delete(endpoint.id);
  }

  /** Drop all device references after the endpoints were deleted externally. */
  clearDevices(): void {
    this.deviceEndpoints.clear();
  }

  /**
   * Update root-level BasicInformation with entity-specific data.
   * In server mode, controllers (Apple Home, Alexa) read the root node's
   * BasicInformation, not the device endpoint's BridgedDeviceBasicInformation.
   * Without this, server-mode devices show bridge defaults (e.g. "riddix" / "MatterHub").
   */
  async updateDeviceIdentity(
    entityId: string,
    device: HomeAssistantDeviceRegistry | undefined,
    mapping: EntityMappingConfig | undefined,
    friendlyName: string | undefined,
  ): Promise<boolean> {
    const nodeLabel =
      trimToLength(mapping?.customName, 32, "...") ??
      trimToLength(friendlyName, 32, "...") ??
      trimToLength(entityId, 32, "...");
    const productNameFromNodeLabel =
      this.featureFlags?.productNameFromNodeLabel === true
        ? (trimToLength(sanitizeMatterString(nodeLabel ?? ""), 32, "...") ??
          undefined)
        : undefined;
    // Reserve room for the suffix so it survives the 32-char cap (#330).
    const maxRawLen = 32 - (this.serialNumberSuffix?.length ?? 0);
    const registrySerial = this.featureFlags?.useHaRegistrySerial
      ? trimToLength(device?.serial_number, maxRawLen, "...")
      : undefined;
    const rawSerial =
      trimToLength(mapping?.customSerialNumber, maxRawLen, "...") ??
      registrySerial;
    const serialNumber =
      rawSerial && this.serialNumberSuffix
        ? `${rawSerial}${this.serialNumberSuffix}`
        : rawSerial;
    const basicInformation = dropUndefined({
      vendorName:
        trimToLength(mapping?.customVendorName, 32, "...") ??
        trimToLength(device?.manufacturer, 32, "..."),
      productName:
        trimToLength(mapping?.customProductName, 32, "...") ??
        productNameFromNodeLabel ??
        trimToLength(device?.model_id, 32, "...") ??
        trimToLength(device?.model, 32, "..."),
      productLabel: trimToLength(device?.model, 64, "..."),
      nodeLabel,
      serialNumber,
      hardwareVersionString: trimToLength(device?.hw_version, 64, "..."),
      softwareVersionString: trimToLength(device?.sw_version, 64, "..."),
    });
    if (Object.keys(basicInformation).length === 0) {
      return true;
    }
    try {
      await this.set({ basicInformation });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        `Failed to apply server-mode identity for ${entityId}: ${msg}`,
      );
      // Reported, not thrown: the caller keeps running but must not remember
      // this identity as delivered, or it never retries (#467).
      return false;
    }
  }

  // align the pairing device-type hint with the real device (default is vacuum)
  async updateAdvertisedDeviceType(deviceType: DeviceTypeId): Promise<boolean> {
    try {
      await this.set({ productDescription: { deviceType } });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`Failed to set server-mode device type: ${msg}`);
      return false;
    }
  }

  async factoryReset(): Promise<void> {
    await this.cancel();
    await this.erase();
  }
}

function dropUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}
