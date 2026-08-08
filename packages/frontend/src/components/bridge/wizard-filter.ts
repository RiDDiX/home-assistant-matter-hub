import {
  type HomeAssistantMatcher,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";

// Filter types the wizard offers for the include rule. Pattern keeps the old
// wildcard behaviour, the rest map onto a single matcher type each.
export type WizardFilterType = "pattern" | "domain" | "area" | "label";

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// Builds the include matchers for the chosen filter type. Kept pure so the
// wizard's handleNext stays thin and the mapping is testable on its own.
export function buildIncludeMatchers(args: {
  filterType: WizardFilterType;
  useWildcard: boolean;
  entityPattern: string;
  labelValues: string[];
}): HomeAssistantMatcher[] {
  const { filterType, useWildcard, entityPattern, labelValues } = args;
  switch (filterType) {
    case "label":
      return labelValues.map((value) => ({
        type: HomeAssistantMatcherType.EntityLabel,
        value,
      }));
    case "area":
      return splitList(entityPattern).map((value) => ({
        type: HomeAssistantMatcherType.Area,
        value,
      }));
    case "domain":
      return splitList(entityPattern).map((value) => ({
        type: HomeAssistantMatcherType.Domain,
        value,
      }));
    default: {
      const patterns = useWildcard
        ? [entityPattern || "*"]
        : splitList(entityPattern);
      return patterns.map((value) => ({
        type: HomeAssistantMatcherType.Pattern,
        value,
      }));
    }
  }
}
