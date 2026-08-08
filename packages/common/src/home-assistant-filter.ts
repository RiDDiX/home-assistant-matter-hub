export enum HomeAssistantMatcherType {
  Pattern = "pattern",
  Regex = "regex",
  Domain = "domain",
  Platform = "platform",
  /** @deprecated Use EntityLabel or DeviceLabel instead */
  Label = "label",
  EntityLabel = "entity_label",
  DeviceLabel = "device_label",
  EntityLabelRegex = "entity_label_regex",
  DeviceLabelRegex = "device_label_regex",
  AnyFieldRegex = "any_field_regex",
  Area = "area",
  EntityCategory = "entity_category",
  DeviceName = "device_name",
  ProductName = "product_name",
  Manufacturer = "manufacturer",
  DeviceClass = "device_class",
}

export interface HomeAssistantMatcher {
  readonly type: HomeAssistantMatcherType;
  readonly value: string;
}

export type HomeAssistantFilterMode = "any" | "all";

export interface HomeAssistantFilter {
  include: HomeAssistantMatcher[];
  exclude: HomeAssistantMatcher[];
  /** How to combine include rules: "any" (OR) or "all" (AND). Default: "any" */
  includeMode?: HomeAssistantFilterMode;
}
