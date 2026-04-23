import type { HomeAssistantFilter } from "./home-assistant-filter.js";

interface AllBridgeFeatureFlags {
  readonly coverDoNotInvertPercentage: boolean;
  readonly coverUseHomeAssistantPercentage: boolean;
  readonly coverSwapOpenClose: boolean;
  readonly includeHiddenEntities: boolean;
  readonly vacuumIncludeUnnamedRooms: boolean;
  /**
   * Server Mode: Expose devices directly as standalone Matter devices instead of bridged devices.
   * This is required for Apple Home to properly support Siri voice commands for Robot Vacuums (RVC).
   * When enabled, only ONE device should be in this bridge - it will be exposed as the root device.
   * Multiple devices in server mode will cause errors.
   */
  readonly serverMode: boolean;
  /**
   * Auto Battery Mapping: Automatically assign battery sensors from the same Home Assistant device
   * to the main entity. When enabled, battery sensors will be merged into their parent devices
   * instead of appearing as separate devices in Matter controllers.
   * Default: false (disabled)
   */
  readonly autoBatteryMapping: boolean;
  /**
   * Auto Humidity Mapping: Automatically combine humidity sensors with temperature sensors
   * from the same Home Assistant device. When enabled, humidity sensors will be merged into
   * temperature sensors to create combined TemperatureHumiditySensor devices.
   * Default: true (enabled)
   */
  readonly autoHumidityMapping: boolean;
  /**
   * Auto Pressure Mapping: Automatically combine pressure sensors with temperature sensors
   * from the same Home Assistant device. When enabled, pressure sensors will be merged into
   * temperature sensors to create combined sensor devices.
   * Default: true (enabled)
   */
  readonly autoPressureMapping: boolean;
  /**
   * Auto Composed Devices: master toggle for all auto-mapping features.
   * When enabled, related entities from the same Home Assistant device are
   * combined into a single Matter endpoint (battery, humidity, pressure,
   * power, energy) — one device in the controller app instead of five.
   * Default: false (disabled)
   */
  readonly autoComposedDevices: boolean;
  /**
   * Auto Force Sync: Periodically push all device states to connected controllers.
   * This is a workaround for Google Home and Alexa which sometimes lose subscriptions
   * and show devices as offline/unresponsive after a few hours.
   * When enabled, the bridge will push all device states every 90 seconds.
   * Default: false (disabled)
   */
  readonly autoForceSync: boolean;
  /**
   * Product Name from Node Label: Report the entity's node label (custom name /
   * friendly name / entity id) as the Matter productName. Useful for controllers
   * like Aqara that display productName as the device name instead of nodeLabel.
   * A per-entity customProductName still takes precedence over this flag.
   * Default: false (disabled)
   */
  readonly productNameFromNodeLabel: boolean;
  /**
   * Prefer Entity Registry Name: Use the entity registry name (or original_name)
   * as nodeLabel instead of the composed friendly_name. Since Home Assistant
   * 2026.4, friendly_name is prefixed with the device name, which breaks voice
   * commands that relied on the short entity name. With this flag enabled,
   * nodeLabel resolves as customName → registry.name → registry.original_name →
   * friendly_name → entity_id. A per-entity customName still takes precedence.
   * Matter has no alias concept, so multiple names per endpoint cannot be
   * exposed — this only controls which single name is reported.
   * Default: false (disabled)
   */
  readonly preferEntityRegistryName: boolean;
  /**
   * Vacuum OnOff Cluster: Add an OnOff cluster to robot vacuum endpoints.
   * Amazon Alexa REQUIRES PowerController (mapped from OnOff) for robotic vacuums.
   * Without it, the vacuum commissions but never appears in the Alexa app.
   *
   * In Server Mode: OnOff is included automatically when this flag is unset.
   * Set to false explicitly to disable (e.g. Apple Home shows "Updating").
   *
   * In Bridge Mode: OnOff is excluded by default. Set to true to enable for Alexa.
   *
   * NOTE: This field intentionally has no schema default so that RJSF does not
   * write false into new bridge configs, which would override the server-mode
   * default-to-true logic in isServerModeVacuumOnOffEnabled().
   */
  readonly vacuumOnOff: boolean;
  /**
   * Alexa Preserve Brightness on Turn-On: workaround for Alexa resetting
   * light brightness to 100% after subscription renewal by emitting
   * on() followed by moveToLevel(254) within ~50ms (#142).
   * When enabled, the bridge ignores moveToLevel commands at maxLevel
   * that arrive within 200ms of a turn-on for the same entity.
   * WARNING: breaks Apple Home's room-level "set to 100%" Siri commands,
   * which use the same on() + moveToLevel(254) pattern (#306).
   * Only enable on Alexa-only bridges.
   * Default: false (disabled).
   */
  readonly alexaPreserveBrightnessOnTurnOn: boolean;
}

export type BridgeFeatureFlags = Partial<AllBridgeFeatureFlags>;

export type BridgeIconType = string;

export interface BridgeConfig {
  readonly name: string;
  readonly port: number;
  readonly filter: HomeAssistantFilter;
  readonly featureFlags?: BridgeFeatureFlags;
  readonly countryCode?: string;
  readonly icon?: BridgeIconType;
  /** Startup priority - lower values start first. Default: 100 */
  readonly priority?: number;
  /**
   * Append a suffix to every entity serial number on this bridge.
   * Useful for forcing controllers like Aqara to treat devices as new
   * and bypass their cached device data.
   */
  readonly serialNumberSuffix?: string;
}

export interface CreateBridgeRequest extends BridgeConfig {}

export interface UpdateBridgeRequest extends BridgeConfig {
  readonly id: string;
}

export interface BridgeBasicInformation {
  vendorId: number;
  vendorName: string;
  productId: number;
  productName: string;
  productLabel: string;
  hardwareVersion: number;
  softwareVersion: number;
  hardwareVersionString?: string;
  softwareVersionString?: string;
}

export interface BridgeData extends BridgeConfig {
  readonly id: string;
  readonly basicInformation: BridgeBasicInformation;
}

export interface FailedEntity {
  readonly entityId: string;
  readonly reason: string;
}

export interface BridgeDataWithMetadata extends BridgeData {
  readonly status: BridgeStatus;
  readonly statusReason?: string;
  readonly commissioning?: BridgeCommissioning | null;
  readonly deviceCount: number;
  readonly failedEntities?: FailedEntity[];
}

export enum BridgeStatus {
  Starting = "starting",
  Running = "running",
  Stopped = "stopped",
  Failed = "failed",
}

export interface BridgeCommissioning {
  readonly isCommissioned: boolean;
  readonly passcode: number;
  readonly discriminator: number;
  readonly manualPairingCode: string;
  readonly qrPairingCode: string;
  readonly fabrics: BridgeFabric[];
}

export interface BridgeFabric {
  readonly fabricIndex: number;
  readonly fabricId: number;
  readonly nodeId: number;
  readonly rootNodeId: number;
  readonly rootVendorId: number;
  readonly label: string;
}
