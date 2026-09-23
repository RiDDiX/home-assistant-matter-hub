import type { ControllerSupport } from "./entity-mapping.js";

export type ControllerKey =
  | "apple"
  | "google"
  | "alexa"
  | "aqara"
  | "smartthings";

// Fabric root vendor ids of the controllers we have support data for.
// Apple 0x1349/0x1384, Google 0x6006, Amazon Alexa 0x1217/0x1160, Aqara 0x115F,
// SmartThings 0x110A. Other ids (incl. Home Assistant 0x134B) classify as
// undefined, so they never raise a warning. Best-effort: a fabric root vendor
// can be the hub vendor rather than the end controller, so warnings stay advisory.
const controllerByVendorId: Record<number, ControllerKey> = {
  4937: "apple", // 0x1349 Apple Home
  4996: "apple", // 0x1384 Apple (iCloud Keychain)
  24582: "google", // 0x6006 Google Home
  4631: "alexa", // 0x1217 Amazon Alexa
  4448: "alexa", // 0x1160 Amazon (some Alexa ecosystems)
  4447: "aqara", // 0x115F Aqara Home
  4362: "smartthings", // 0x110A SmartThings
};

export function classifyController(
  vendorId: number,
): ControllerKey | undefined {
  return controllerByVendorId[vendorId];
}

// Alexa only completes the operational CASE connect on port 5540, a pairing on
// any other port rolls back after AddNOC (#401).
export function alexaPairingPortProblem(
  vendorId: number,
  port: number,
): boolean {
  return classifyController(vendorId) === "alexa" && port !== 5540;
}

interface DeviceTypeSupport {
  apple: ControllerSupport;
  google: ControllerSupport;
  alexa: ControllerSupport;
  aqara: ControllerSupport;
  smartthings: ControllerSupport;
  note?: string;
}

// Controller support keyed by the NUMERIC Matter device type id an endpoint
// actually carries (endpoint.type.deviceType). Device-type granularity: all air
// quality concentration sensors are 0x002c, motion and occupancy are both
// 0x0107, so collapsing to the id is correct here. Only ids that are
// unsupported ("no") somewhere need an entry; anything absent never warns.
// Same sources and date as matterDeviceTypeControllerSupport (2026-09).
const deviceTypeIdSupport: Record<number, DeviceTypeSupport> = {
  // speaker
  34: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Apple and Alexa do not show Matter speakers.",
  },
  // basic video player
  40: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "TV/media types only show in Aqara Home and SmartThings.",
  },
  // pressure sensor
  773: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Google Home, Aqara and SmartThings show pressure sensors.",
  },
  // flow sensor
  774: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Google Home, Aqara and SmartThings show flow sensors.",
  },
  // solar power
  23: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "yes",
    smartthings: "yes",
    note: "SolarPower is only shown standalone by Aqara and SmartThings.",
  },
  // electrical meter
  1300: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "unknown",
    smartthings: "unknown",
    note: "ElectricalMeter shows in Google Home; Apple and Alexa do not show standalone power/energy.",
  },
  // electrical utility meter
  1297: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "unknown",
    smartthings: "unknown",
    note: "ElectricalUtilityMeter shows in Google Home only.",
  },
  // battery storage
  24: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Aqara and SmartThings list battery storage; others show battery inside a device.",
  },
  // EVSE
  1292: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "HA, Aqara and SmartThings render EnergyEvse (SmartThings sets the limit via EnableCharging and addresses modes by list position). Bridged EVSE can break Alexa device recognition, keep it off Alexa bridges.",
  },
  // water heater
  1295: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "yes",
    smartthings: "yes",
    note: "Matter 1.4 Water Heater, only Aqara and SmartThings list it.",
  },
  // mode select
  39: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "no",
    smartthings: "unknown",
    note: "Mode Select is not supported here (Google #356).",
  },
  // water valve
  66: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
  },
  // pump
  771: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Google Home, Aqara and SmartThings show pumps.",
  },
  // rain sensor
  68: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Newer Matter detector, thin support; Alexa may reject it (#365).",
  },
  // water freeze detector
  65: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Newer Matter detector, thin support; Alexa may reject it (#365).",
  },
  // water leak detector
  67: {
    apple: "yes",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "Alexa has no capability for it and it can take an Alexa bridge offline (#365).",
  },
  // laundry washer
  115: {
    apple: "unknown",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "iOS 27 knows the type, but it's not confirmed that Apple Home shows it.",
  },
  // laundry dryer
  124: {
    apple: "unknown",
    google: "no",
    alexa: "no",
    aqara: "yes",
    smartthings: "yes",
    note: "iOS 27 knows the type, but it's not confirmed that Apple Home shows it.",
  },
  // doorbell
  328: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "no",
    smartthings: "unknown",
    note: "Google Home lists the Matter 1.4 Doorbell; others fall back to the plain Switch cluster, if they show it at all.",
  },
  // generic switch
  15: {
    apple: "partial",
    google: "no",
    alexa: "yes",
    aqara: "yes",
    smartthings: "yes",
  },
};

const controllerLabels: Record<ControllerKey, string> = {
  apple: "Apple Home",
  google: "Google Home",
  alexa: "Alexa",
  aqara: "Aqara Home",
  smartthings: "SmartThings",
};

export interface ControllerWarning {
  entityId: string;
  deviceTypeId: number;
  controller: ControllerKey;
  controllerLabel: string;
  note?: string;
}

export interface ExposedDeviceType {
  entityId: string;
  deviceTypeId: number;
}

/**
 * Warn when a bridge exposes a device type that a controller commissioned onto
 * it does not support. Only fires on a hard "no", so partial/unknown cases do
 * not raise false alarms. Advisory only, the bridge structure is never changed.
 */
export function computeControllerWarnings(
  controllers: ControllerKey[],
  exposed: ExposedDeviceType[],
): ControllerWarning[] {
  const seen = new Set<string>();
  const warnings: ControllerWarning[] = [];
  for (const { entityId, deviceTypeId } of exposed) {
    const support = deviceTypeIdSupport[deviceTypeId];
    if (!support) continue;
    for (const controller of controllers) {
      if (support[controller] !== "no") continue;
      const key = `${entityId}:${deviceTypeId}:${controller}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        entityId,
        deviceTypeId,
        controller,
        controllerLabel: controllerLabels[controller],
        note: support.note,
      });
    }
  }
  return warnings;
}

// Same warnings, but straight from a bridge's commissioned fabrics. Dedupes the
// controllers first so two fabrics of the same ecosystem only warn once.
export function controllerWarningsForFabrics(
  fabrics: { rootVendorId: number }[],
  exposed: ExposedDeviceType[],
): ControllerWarning[] {
  const controllers = [
    ...new Set(
      fabrics
        .map((f) => classifyController(f.rootVendorId))
        .filter((c): c is ControllerKey => c !== undefined),
    ),
  ];
  if (controllers.length === 0) return [];
  return computeControllerWarnings(controllers, exposed);
}
