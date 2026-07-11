import crypto from "node:crypto";
import type { HomeAssistantEntityInformation } from "@home-assistant-matter-hub/common";
import { Logger } from "@matter/general";
import { VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer as Base } from "@matter/main/behaviors";
import { BridgeDataProvider } from "../../services/bridges/bridge-data-provider.js";
import { applyPatchState } from "../../utils/apply-patch-state.js";
import { sanitizeMatterString } from "../../utils/sanitize-matter-string.js";
import { trimToLength } from "../../utils/trim-to-length.js";
import { HomeAssistantEntityBehavior } from "./home-assistant-entity-behavior.js";

const logger = Logger.get("BasicInformationServer");

// UniqueID is fixed quality per Matter spec, so it must not change while the
// process runs. Frozen here per bridge+entity; a uniqueIdSuffix change only
// applies on the next HAMH restart (#385).
const appliedUniqueIds = new Map<string, string>();

export class BasicInformationServer extends Base {
  override async initialize(): Promise<void> {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update(homeAssistant.entity);
    this.reactTo(homeAssistant.onChange, this.update, { offline: true });
  }

  private update(entity: HomeAssistantEntityInformation) {
    if (!entity.state || !entity.state.attributes) {
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
    // Reserve room for the suffix so it survives the 32-char cap; otherwise
    // appending and then trimming chops the suffix off (#330).
    const maxRawLen = 32 - (serialNumberSuffix?.length ?? 0);
    const registrySerial = featureFlags?.useHaRegistrySerial
      ? ellipse(maxRawLen, device?.serial_number)
      : undefined;
    const rawSerial =
      ellipse(maxRawLen, mapping?.customSerialNumber) ??
      registrySerial ??
      hash(maxRawLen, entity.entity_id);
    const serialNumber =
      rawSerial && serialNumberSuffix
        ? `${rawSerial}${serialNumberSuffix}`
        : rawSerial;
    const customVendorId = mapping?.customVendorId;
    const vendorId = isValidVendorId(customVendorId)
      ? customVendorId
      : basicInformation.vendorId;
    applyPatchState(this.state, {
      vendorId: VendorId(vendorId),
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
        ellipse(64, mapping?.customProductName) ??
        ellipse(64, device?.model) ??
        hash(64, basicInformation.productLabel),
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
      // uniqueIdSuffix mints a fresh identity so stale controller cloud
      // records keyed on it can be shed (#385).
      uniqueId: this.frozenUniqueId(entity.entity_id),
    });
    logger.debug(
      `[${entity.entity_id}] basicInfo vendor=${this.state.vendorName} product=${this.state.productName} label=${this.state.productLabel} serial=${this.state.serialNumber} node=${this.state.nodeLabel} uniqueId=${this.state.uniqueId}`,
    );
  }

  private frozenUniqueId(entityId: string): string {
    const provider = this.env.get(BridgeDataProvider);
    const key = `${provider.id}:${entityId}`;
    let uniqueId = appliedUniqueIds.get(key);
    if (uniqueId == null) {
      uniqueId = crypto
        .createHash("md5")
        .update(entityId + (provider.uniqueIdSuffix ?? ""))
        .digest("hex")
        .substring(0, 32);
      appliedUniqueIds.set(key, uniqueId);
    }
    return uniqueId;
  }
}

export function ellipse(maxLength: number, value?: string) {
  return trimToLength(value, maxLength, "...");
}

export function hash(maxLength: number, value?: string) {
  const hashLength = 4;
  const suffix = crypto
    .createHash("md5")
    .update(value ?? "")
    .digest("hex")
    .substring(0, hashLength);
  return trimToLength(value, maxLength, suffix);
}

function isValidVendorId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 0xfffe
  );
}
