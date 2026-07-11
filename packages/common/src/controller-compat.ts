import type { ControllerSupport } from "./entity-mapping.js";

export type ControllerKey = "apple" | "google" | "alexa" | "aqara";

// Fabric root vendor ids of the controllers we have support data for.
// Apple 0x1349/0x1384, Google 0x6006, Amazon Alexa 0x1217/0x1160, Aqara 0x115F.
// Other ids (incl. Home Assistant 0x134B and SmartThings 0x110A) classify as
// undefined, so they never raise a warning. Best-effort: a fabric root vendor
// can be the hub vendor rather than the end controller, so warnings stay advisory.
const controllerByVendorId: Record<number, ControllerKey> = {
  4937: "apple", // 0x1349 Apple Home
  4996: "apple", // 0x1384 Apple (iCloud Keychain)
  24582: "google", // 0x6006 Google Home
  4631: "alexa", // 0x1217 Amazon Alexa
  4448: "alexa", // 0x1160 Amazon (some Alexa ecosystems)
  4447: "aqara", // 0x115F Aqara Home
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
  note?: string;
}

// Controller support keyed by the NUMERIC Matter device type id an endpoint
// actually carries (endpoint.type.deviceType). Device-type granularity: all air
// quality concentration sensors are 0x002c, motion and occupancy are both
// 0x0107, so collapsing to the id is correct here. Only ids that are
// unsupported ("no") somewhere need an entry; anything absent never warns.
// Apple/Google/Alexa verified 2026-06 against their device pages. Aqara from its
// own Matter device list (aqara.com/en/explore/everything-matter, 2026-06), which
// covers most types; "unknown" where Aqara does not name the type. Snapshot.
const deviceTypeIdSupport: Record<number, DeviceTypeSupport> = {
  43: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home has no standalone fan.",
  },
  45: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home does not list air purifiers.",
  },
  34: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Google Home and Aqara show Matter speakers.",
  },
  40: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "TV/media types only show in Aqara Home here.",
  },
  773: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Google Home and Aqara show pressure sensors.",
  },
  774: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "unknown",
    note: "Only Google Home shows flow sensors.",
  },
  44: {
    apple: "no",
    google: "yes",
    alexa: "yes",
    aqara: "yes",
    note: "Apple Home does not show air quality.",
  },
  23: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "Power/energy is rarely shown unless it is on a smart plug.",
  },
  24: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Aqara lists battery storage; others show battery inside a device.",
  },
  39: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "unknown",
    note: "Mode Select is not supported here (Google #356).",
  },
  66: { apple: "no", google: "no", alexa: "no", aqara: "yes" },
  771: {
    apple: "no",
    google: "yes",
    alexa: "no",
    aqara: "yes",
    note: "Google Home and Aqara show pumps.",
  },
  68: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Newer Matter detector, thin support; Alexa may reject it (#365).",
  },
  65: {
    apple: "no",
    google: "no",
    alexa: "no",
    aqara: "yes",
    note: "Newer Matter detector, thin support; Alexa may reject it (#365).",
  },
  67: {
    apple: "yes",
    google: "no",
    alexa: "yes",
    aqara: "yes",
    note: "Newer Matter detector, can be risky on Alexa bridges (#365).",
  },
  118: { apple: "yes", google: "no", alexa: "yes", aqara: "yes" },
  117: {
    apple: "no",
    google: "no",
    alexa: "unknown",
    aqara: "unknown",
    note: "Appliance types have little controller support.",
  },
  15: { apple: "partial", google: "no", alexa: "yes", aqara: "unknown" },
};

const controllerLabels: Record<ControllerKey, string> = {
  apple: "Apple Home",
  google: "Google Home",
  alexa: "Alexa",
  aqara: "Aqara Home",
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
