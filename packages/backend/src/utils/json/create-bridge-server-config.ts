import crypto from "node:crypto";
import type { BridgeData } from "@home-assistant-matter-hub/common";
import { AggregatorEndpoint } from "@matter/main/endpoints";
import type { Node, ServerNode } from "@matter/main/node";
import { VendorId } from "@matter/main/types";
import { legacySpecBasicInformation } from "../../matter/legacy-spec-version.js";
import { matterSubscriptionOptions } from "../../matter/subscription-options.js";
import { rootEndpointType } from "../../matter/tc-general-commissioning.js";
import { CAMERA_TCP_CONFIG } from "../../plugins/builtin/camera/camera-tcp-requirement.js";
import { trimToLength } from "../trim-to-length.js";

export type BridgeServerNodeConfig =
  Node.Configuration<ServerNode.RootEndpoint>;

export function createBridgeServerConfig(
  data: BridgeData,
  options?: { tcp?: { incoming: boolean; outgoing: boolean } },
): BridgeServerNodeConfig {
  return {
    type: rootEndpointType(data.featureFlags),
    id: data.id,
    network: {
      port: data.port,
      subscriptionOptions: matterSubscriptionOptions(),
      // camera serverOptions win, the flag reuses the same listener config
      ...(options?.tcp
        ? { tcp: options.tcp }
        : data.featureFlags?.enableMatterTcp
          ? { tcp: CAMERA_TCP_CONFIG }
          : {}),
    },
    productDescription: {
      name: data.name,
      deviceType: AggregatorEndpoint.deviceType,
    },
    basicInformation: {
      ...legacySpecBasicInformation(data.featureFlags),
      uniqueId: data.id,
      nodeLabel: trimToLength(data.name, 32, "..."),
      vendorId: VendorId(data.basicInformation.vendorId),
      vendorName: data.basicInformation.vendorName,
      productId: data.basicInformation.productId,
      productName: data.basicInformation.productName,
      productLabel: data.basicInformation.productLabel,
      serialNumber: crypto
        .createHash("md5")
        .update(`serial-${data.id}`)
        .digest("hex")
        .substring(0, 32),
      hardwareVersion: data.basicInformation.hardwareVersion,
      softwareVersion: data.basicInformation.softwareVersion,
      hardwareVersionString: data.basicInformation.hardwareVersionString,
      // Keep the root string aligned with the numeric softwareVersion. Aqara
      // stalls bridge registration when the two diverge (#316).
      softwareVersionString: String(data.basicInformation.softwareVersion),
      ...(data.countryCode ? { location: data.countryCode } : {}),
    },
    subscriptions: {
      persistenceEnabled: false,
    },
  };
}
