import type {
  HomeAssistantDeviceRegistry,
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
  HomeAssistantFilterMode,
  HomeAssistantMatcher,
} from "@home-assistant-matter-hub/common";
import type { HomeAssistantLabel } from "../../home-assistant/api/get-registry.js";

/**
 * Test if an entity matches any or all of the matchers based on mode.
 * @param matchers - Array of matchers to test
 * @param device - Device registry entry (optional)
 * @param entity - Entity registry entry
 * @param mode - "any" (OR) or "all" (AND), defaults to "any"
 */
export function testMatchers(
  matchers: HomeAssistantMatcher[],
  device: HomeAssistantDeviceRegistry | undefined,
  entity: HomeAssistantEntityRegistry,
  mode: HomeAssistantFilterMode = "any",
  entityState?: HomeAssistantEntityState,
  labels?: HomeAssistantLabel[],
) {
  if (mode === "all") {
    return matchers.every((matcher) =>
      testMatcher(matcher, device, entity, entityState, labels),
    );
  }
  return matchers.some((matcher) =>
    testMatcher(matcher, device, entity, entityState, labels),
  );
}

export function testMatcher(
  matcher: HomeAssistantMatcher,
  device: HomeAssistantDeviceRegistry | undefined,
  entity: HomeAssistantEntityRegistry,
  entityState?: HomeAssistantEntityState,
  labels?: HomeAssistantLabel[],
): boolean {
  if (matcher.value == null) {
    return false;
  }
  switch (matcher.type) {
    case "domain":
      return entity.entity_id.split(".")[0] === matcher.value;
    case "label":
    case "entity_label": {
      const slug = resolveLabelValue(matcher.value, labels);
      return !!entity?.labels && entity.labels.includes(slug);
    }
    case "device_label": {
      const slug = resolveLabelValue(matcher.value, labels);
      return !!device?.labels && device.labels.includes(slug);
    }
    case "entity_label_regex":
      return testLabelRegex(matcher.value, entity?.labels, labels);
    case "device_label_regex":
      return testLabelRegex(matcher.value, device?.labels, labels);
    case "any_field_regex":
      return testAnyFieldRegex(
        matcher.value,
        entity,
        device,
        entityState,
        labels,
      );
    case "entity_category":
      return entity?.entity_category === matcher.value;
    case "platform":
      return entity?.platform === matcher.value;
    case "pattern":
      return patternToRegex(matcher.value).test(entity.entity_id);
    case "regex":
      return testRegex(matcher.value, entity.entity_id);
    case "area":
      return (entity?.area_id ?? device?.area_id) === matcher.value;
    case "device_name":
      return testDeviceName(matcher.value, device);
    case "product_name":
      return testProductName(matcher.value, device);
    case "manufacturer":
      return testManufacturer(matcher.value, device);
    case "device_class":
      return entityState?.attributes?.device_class === matcher.value;
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const regex = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${regex}$`);
}

function testRegex(pattern: string, value: string): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(value);
  } catch {
    return false;
  }
}

function testLabelRegex(
  pattern: string,
  assigned: string[] | undefined,
  labels?: HomeAssistantLabel[],
): boolean {
  if (!assigned?.length) {
    return false;
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return false;
  }
  for (const slug of assigned) {
    if (regex.test(slug)) {
      return true;
    }
    const named = labels?.find((l) => l.label_id === slug)?.name;
    if (named && regex.test(named)) {
      return true;
    }
  }
  return false;
}

function testAnyFieldRegex(
  pattern: string,
  entity: HomeAssistantEntityRegistry,
  device: HomeAssistantDeviceRegistry | undefined,
  entityState: HomeAssistantEntityState | undefined,
  labels: HomeAssistantLabel[] | undefined,
): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return false;
  }
  return regex.test(buildEntityHaystack(entity, device, entityState, labels));
}

function buildEntityHaystack(
  entity: HomeAssistantEntityRegistry,
  device: HomeAssistantDeviceRegistry | undefined,
  entityState: HomeAssistantEntityState | undefined,
  labels: HomeAssistantLabel[] | undefined,
): string {
  const domain = entity.entity_id.split(".")[0];
  const entityArea =
    entity.area_id ??
    (typeof device?.area_id === "string" ? device.area_id : "");
  const entityCategory =
    typeof entity.entity_category === "string" ? entity.entity_category : "";
  const deviceClass =
    typeof entityState?.attributes?.device_class === "string"
      ? entityState.attributes.device_class
      : "";
  const entityLabelSlugs = entity.labels ?? [];
  const deviceLabelSlugs = device?.labels ?? [];
  const entityLabelNames = entityLabelSlugs
    .map((slug) => labels?.find((l) => l.label_id === slug)?.name ?? "")
    .filter((name) => name.length > 0);
  const deviceLabelNames = deviceLabelSlugs
    .map((slug) => labels?.find((l) => l.label_id === slug)?.name ?? "")
    .filter((name) => name.length > 0);
  const deviceName =
    device?.name_by_user ?? device?.name ?? device?.default_name ?? "";
  const productName = device?.model ?? device?.default_model ?? "";
  return [
    `entity_id=${entity.entity_id}`,
    `domain=${domain}`,
    `platform=${entity.platform ?? ""}`,
    `area=${entityArea ?? ""}`,
    `entity_category=${entityCategory}`,
    `device_class=${deviceClass}`,
    `entity_labels=${entityLabelSlugs.join(",")}`,
    `entity_label_names=${entityLabelNames.join(",")}`,
    `device_labels=${deviceLabelSlugs.join(",")}`,
    `device_label_names=${deviceLabelNames.join(",")}`,
    `device_name=${deviceName}`,
    `product_name=${productName}`,
    `manufacturer=${device?.manufacturer ?? device?.default_manufacturer ?? ""}`,
  ].join(" ");
}

function testDeviceName(
  pattern: string,
  device: HomeAssistantDeviceRegistry | undefined,
): boolean {
  if (!device) {
    return false;
  }
  const deviceName = device.name_by_user ?? device.name ?? device.default_name;
  if (!deviceName) {
    return false;
  }
  const lowerPattern = pattern.toLowerCase();
  const lowerDeviceName = deviceName.toLowerCase();
  if (lowerPattern.includes("*")) {
    return patternToRegex(lowerPattern).test(lowerDeviceName);
  }
  return lowerDeviceName.includes(lowerPattern);
}

function testProductName(
  pattern: string,
  device: HomeAssistantDeviceRegistry | undefined,
): boolean {
  if (!device) {
    return false;
  }
  const productName = device.model ?? device.default_model;
  if (!productName) {
    return false;
  }
  const lowerPattern = pattern.toLowerCase();
  const lowerProductName = productName.toLowerCase();
  if (lowerPattern.includes("*")) {
    return patternToRegex(lowerPattern).test(lowerProductName);
  }
  return lowerProductName.includes(lowerPattern);
}

function testManufacturer(
  pattern: string,
  device: HomeAssistantDeviceRegistry | undefined,
): boolean {
  if (!device) {
    return false;
  }
  const manufacturer = device.manufacturer ?? device.default_manufacturer;
  if (!manufacturer) {
    return false;
  }
  const lowerPattern = pattern.toLowerCase();
  const lowerManufacturer = manufacturer.toLowerCase();
  if (lowerPattern.includes("*")) {
    return patternToRegex(lowerPattern).test(lowerManufacturer);
  }
  return lowerManufacturer.includes(lowerPattern);
}

function resolveLabelValue(
  value: string,
  labels?: HomeAssistantLabel[],
): string {
  if (labels) {
    const match = labels.find(
      (l) => l.name.toLowerCase() === value.toLowerCase(),
    );
    if (match) return match.label_id;
  }
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
