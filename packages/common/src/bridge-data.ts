import type { ControllerWarning } from "./controller-compat.js";
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
   * One node carries up to 10 device endpoints (#301); the first entity is the
   * primary and drives the node identity. More than one device is experimental.
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
   * power, energy), one device in the controller app instead of five.
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
   * exposed, this only controls which single name is reported.
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
  /**
   * Use HA Registry Serial Number: when set, fall back to the Home Assistant
   * device registry serial_number for the Matter serialNumber attribute when
   * no per-entity customSerialNumber is configured. Default off because
   * changing serialNumber after commissioning can confuse controllers.
   * Resolution order: customSerialNumber > device.serial_number (when this
   * flag is on) > entity-ID-based hash.
   * Default: false (disabled)
   */
  readonly useHaRegistrySerial: boolean;
  /**
   * Cover slider debounce (ms). >0 overrides the built-in 400/150 ms
   * two-phase debounce with a single window. For controllers like Apple Home
   * that stream slider updates. Per-entity override wins over this. 0 = unset.
   */
  readonly coverSliderDebounceMs: number;
  readonly fanSliderDebounceMs: number;
  /**
   * Fast Session Recovery: when a controller drops all subscriptions, clean up
   * the dead session and re-announce after 5s instead of 60s (#386). Shortens
   * the offline window, does not stop the controller rejecting the sub.
   * Default: false (disabled)
   */
  readonly fastSessionRecovery: boolean;
  /**
   * Omit events from the initial subscription report. Google's stack has been
   * seen to MRP-ack every priming chunk but never answer the final one at the
   * Interaction Model level, and that chunk carries the stored StartUp and
   * BootReason events: the subscription aborts after ~11s and the device stays
   * offline forever (#424). With this flag the priming report carries
   * attributes only. Live events still reach the controller once the
   * subscription stands. Off-spec, so opt-in per bridge.
   * Default: false (disabled)
   */
  readonly omitEventsInPriming: boolean;
  /** Advertise Matter 1.5.1 instead of 1.6.0, pairing diagnostic for older Alexa stacks (#449). */
  readonly advertiseSpecVersion151: boolean;
  /** Accept SetTcAcknowledgements instead of rejecting it, pairing experiment for Echo stalls (#449). */
  readonly supportTermsAndConditions: boolean;
  /** Open a Matter TCP listener like camera bridges do, pairing experiment for Echo stalls (#449). */
  readonly enableMatterTcp: boolean;
  /**
   * Stable Device Identity: anchor each device's Matter endpoint id, uniqueId
   * and serialNumber to the Home Assistant entity registry unique_id instead of
   * the entity_id. Renaming an entity in HA then no longer re-mints the device,
   * so controllers keep their groups, names and automations. Identity records
   * are always seeded, so turning this on later never re-adds existing devices.
   * Default: false (disabled)
   */
  readonly stableIdentity: boolean;
  /**
   * Wedge Watchdog: rotate the one session that looks wedged (subscriptions
   * alive but no inbound Interaction Model request for ~45min) earlier than the
   * blind session rotation would. Targets the Apple "Updating" wedge where the
   * controller keeps acking pushed reports but stops consuming data. A false
   * positive costs only a transparent re-CASE, the same as blind rotation.
   * Default: false (disabled)
   */
  readonly wedgeWatchdog: boolean;
  /**
   * Composed devices: put the primary entity on the parent endpoint instead of
   * on a sub-endpoint, so the parent advertises [<app device type>, 0x0013]
   * like a standalone device does. Without it the parent is a bare Bridged Node
   * and Apple Home has no device type to derive the accessory category from, so
   * it picks one of the children (#469). Changes the endpoint tree of an
   * existing composed device, which means it has to be removed and re-added in
   * the controller. Opt-in because #218 saw Apple Home stop listing the
   * sub-endpoints of a composed device once the parent had its own application
   * device type.
   * Default: false (disabled)
   */
  readonly composedPrimaryOnParent: boolean;
}

export type BridgeFeatureFlags = Partial<AllBridgeFeatureFlags>;

export type BridgeIconType =
  | "light"
  | "switch"
  | "climate"
  | "cover"
  | "fan"
  | "lock"
  | "sensor"
  | "media_player"
  | "vacuum"
  | "remote"
  | "humidifier"
  | "speaker"
  | "garage"
  | "door"
  | "window"
  | "motion"
  | "battery"
  | "power"
  | "camera"
  | "default";

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
  /**
   * Mixed into every bridged device uniqueId (standard bridge mode).
   * Controllers like Alexa cache device records keyed on the uniqueId, so
   * changing this can mint fresh identities. Applies on restart (#385).
   */
  readonly uniqueIdSuffix?: string;
  /**
   * Opt-in age-based session rotation (standard and Server Mode). Rotate
   * matter sessions older than this many hours so iPhone clients
   * re-establish CASE and re-subscribe, which unsticks Apple Home
   * "Updating" tiles (#287). 0 disables. Range 0..168.
   * Falls back to HAMH_MATTER_SESSION_MAX_AGE_HOURS, then 4.
   */
  readonly sessionMaxAgeHours?: number;
}

export interface CreateBridgeRequest extends Omit<BridgeConfig, "port"> {
  /** Optional on create, the backend assigns the next free port if omitted. */
  readonly port?: number;
}

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
  // ISO time the entity failed, so the UI can tell fresh from old failures.
  readonly failedAt?: string;
}

export interface BridgeDataWithMetadata extends BridgeData {
  readonly status: BridgeStatus;
  readonly statusReason?: string;
  readonly commissioning?: BridgeCommissioning | null;
  readonly deviceCount: number;
  readonly failedEntities?: FailedEntity[];
  readonly controllerWarnings?: ControllerWarning[];
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
