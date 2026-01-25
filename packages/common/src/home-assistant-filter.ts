export enum HomeAssistantMatcherType {
  Pattern = "pattern",
  Regex = "regex",
  Domain = "domain",
  Platform = "platform",
  Label = "label",
  Area = "area",
  EntityCategory = "entity_category",
  DeviceName = "device_name",
}

export interface HomeAssistantMatcher {
  readonly type: HomeAssistantMatcherType;
  readonly value: string;
}

export interface HomeAssistantFilter {
  include: HomeAssistantMatcher[];
  exclude: HomeAssistantMatcher[];
}
