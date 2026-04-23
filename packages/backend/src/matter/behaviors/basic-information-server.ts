import crypto from "node:crypto";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer as Base } from "@matter/main/behaviors";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { sanitizeMatterString } from "../../utils/sanitize-matter-string.js";
import { trimToLength } from "../../utils/trim-to-length.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

export class BasicInformationServer extends Base {
  override async initialize(): Promise<void> {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update);
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state?.attributes) {
      return;
    }
    const { basicInformation, featureFlags } = this.env.get(BridgeDataProvider);
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const device = entity.deviceRegistry;
    const mapping = homeAssistant.state.mapping;
    const registryName = featureFlags?.preferEntityRegistryName
      ? (entity.registry?.name ?? entity.registry?.original_name)
      : undefined;
    const nodeLabel =
      ellipse(32, homeAssistant.state.customName) ??
      ellipse(32, registryName) ??
      ellipse(32, entity.state?.attributes?.friendly_name) ??
      ellipse(32, entity.entity_id);
    const productNameFromNodeLabel =
      featureFlags?.productNameFromNodeLabel === true
        ? (ellipse(32, sanitizeMatterString(nodeLabel ?? "")) ?? undefined)
        : undefined;
    const serialNumberSuffix =
      this.env.get(BridgeDataProvider).serialNumberSuffix;
    const rawSerial =
      ellipse(32, mapping?.customSerialNumber) ?? hash(32, entity.entity_id);
    const serialNumber = serialNumberSuffix
      ? ellipse(32, `${rawSerial}${serialNumberSuffix}`)
      : rawSerial;
    applyPatchState(this.state, {
      vendorId: VendorId(basicInformation.vendorId),
      vendorName:
        ellipse(32, mapping?.customVendorName) ??
        ellipse(32, device?.manufacturer) ??
        hash(32, basicInformation.vendorName),
      productName:
        ellipse(32, mapping?.customProductName) ??
        productNameFromNodeLabel ??
        ellipse(32, device?.model_id) ??
        ellipse(32, device?.model) ??
        hash(32, basicInformation.productName),
      productLabel:
        ellipse(64, device?.model) ?? hash(64, basicInformation.productLabel),
      hardwareVersion: basicInformation.hardwareVersion,
      softwareVersion: basicInformation.softwareVersion,
      hardwareVersionString: ellipse(64, device?.hw_version),
      softwareVersionString: ellipse(64, device?.sw_version),
      nodeLabel,
      reachable:
        entity.state?.state != null && entity.state.state !== "unavailable",
      serialNumber,
      // UniqueId helps controllers (especially Alexa) identify devices across
      // multiple fabric connections. Using MD5 hash of entity_id for stability.
      uniqueId: crypto
        .createHash("md5")
        .update(entity.entity_id)
        .digest("hex")
        .substring(0, 32),
    });
  }
}

function ellipse(maxLength: number, value?: string) {
  return trimToLength(value, maxLength, "...");
}

function hash(maxLength: number, value?: string) {
  const hashLength = 4;
  const suffix = crypto
    .createHash("md5")
    .update(value ?? "")
    .digest("hex")
    .substring(0, hashLength);
  return trimToLength(value, maxLength, suffix);
}
