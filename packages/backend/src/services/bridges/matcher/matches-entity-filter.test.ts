import {
  type HomeAssistantDeviceRegistry,
  type HomeAssistantEntityRegistry,
  HomeAssistantMatcherType,
} from "@home-assistant-matter-hub/common";
import { describe, expect, it } from "vitest";
import { testMatcher } from "./matches-entity-filter.js";

const registry: HomeAssistantEntityRegistry = {
  id: "id",
  device_id: "device4711",
  entity_id: "light.my_entity",
  categories: {},
  has_entity_name: true,
  original_name: "any",
  unique_id: "unique_id",
  entity_category: "diagnostic",
  platform: "hue",
  labels: ["test_label"],
};

const registryWithArea = { ...registry, area_id: "area_id" };

const deviceRegistry: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
};

const deviceRegistryWithName: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  name: "Living Room Light",
};

const deviceRegistryWithUserName: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  name: "Living Room Light",
  name_by_user: "My Custom Light Name",
};

const deviceRegistryWithModel: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  name: "Living Room Light",
  model: "Hue Color Bulb",
};

const deviceRegistryWithDefaultModel: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  default_model: "Generic LED Bulb",
};

const deviceRegistryWithManufacturer: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  manufacturer: "Sonoff",
};

const deviceRegistryWithDefaultManufacturer: HomeAssistantDeviceRegistry = {
  id: "device4711",
  area_id: "area_id",
  default_manufacturer: "Generic",
};

describe("matchEntityFilter.testMatcher", () => {
  it("should match the domain", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Domain,
          value: "light",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the domain", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Domain,
          value: "switch",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the label", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "test_label",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the label", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "other_label",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should NOT match device label with legacy label type", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["device_label"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "device_label",
        },
        deviceWithLabel,
        entityWithoutLabel,
      ),
    ).toBeFalsy();
  });
  it("should match entity label with EntityLabel type", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabel,
          value: "test_label",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should NOT match device label with EntityLabel type", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["device_label"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabel,
          value: "device_label",
        },
        deviceWithLabel,
        entityWithoutLabel,
      ),
    ).toBeFalsy();
  });
  it("should match device label with DeviceLabel type", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["device_label"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceLabel,
          value: "device_label",
        },
        deviceWithLabel,
        entityWithoutLabel,
      ),
    ).toBeTruthy();
  });
  it("should NOT match entity label with DeviceLabel type", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceLabel,
          value: "test_label",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should not match label when neither entity nor device has it", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["other_label"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "missing_label",
        },
        deviceWithLabel,
        entityWithoutLabel,
      ),
    ).toBeFalsy();
  });
  it("should match label case-insensitively (slugify fallback)", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "Test_Label",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should resolve label display name via labels registry", () => {
    const labels = [
      { label_id: "test_label", name: "Test Label" },
      { label_id: "other", name: "Other" },
    ];
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "Test Label",
        },
        undefined,
        registry,
        undefined,
        labels,
      ),
    ).toBeTruthy();
  });
  it("should resolve label display name for DeviceLabel type", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["matter"] };
    const labels = [{ label_id: "matter", name: "Matter" }];
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceLabel,
          value: "Matter",
        },
        deviceWithLabel,
        entityWithoutLabel,
        undefined,
        labels,
      ),
    ).toBeTruthy();
  });
  it("should NOT match device label via legacy label type with label registry", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["matter"] };
    const labels = [{ label_id: "matter", name: "Matter" }];
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "Matter",
        },
        deviceWithLabel,
        entityWithoutLabel,
        undefined,
        labels,
      ),
    ).toBeFalsy();
  });
  it("should slugify label value with special characters", () => {
    const entityWithLabel = { ...registry, labels: ["my_smart_lights"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Label,
          value: "My Smart Lights",
        },
        undefined,
        entityWithLabel,
      ),
    ).toBeTruthy();
  });

  it("should match the platform", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Platform,
          value: "hue",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the platform", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Platform,
          value: "not_hue",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the area", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "area_id",
        },
        undefined,
        registryWithArea,
      ),
    ).toBeTruthy();
  });
  it("should not match the area", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "another_area_id",
        },
        undefined,
        registryWithArea,
      ),
    ).toBeFalsy();
  });
  it("should match the device area when entity has no area", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "area_id",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the device area when entity has no area", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "another_area_id",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should match when entity and device are in different areas", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "area_id",
        },
        deviceRegistry,
        registryWithArea,
      ),
    ).toBeTruthy();
  });
  it("should not match when entity and device are in different areas", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Area,
          value: "another_area_id",
        },
        deviceRegistry,
        registryWithArea,
      ),
    ).toBeFalsy();
  });
  it("should match the entity category", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityCategory,
          value: "diagnostic",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the entity category", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityCategory,
          value: "configuration",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the pattern", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Pattern,
          value: "light.my_en*t*",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the pattern", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Pattern,
          value: "light.my_en*z*",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Regex,
          value: "^light\\.my_.*$",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match a complex regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Regex,
          value: "^(light|switch)\\..*entity$",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match the regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Regex,
          value: "^switch\\..*$",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should return false for invalid regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Regex,
          value: "[invalid(regex",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match entity label by regex (slug)", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabelRegex,
          value: "^test_.*$",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match entity label regex when entity has no labels", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabelRegex,
          value: ".*",
        },
        undefined,
        entityWithoutLabel,
      ),
    ).toBeFalsy();
  });
  it("should match entity label regex against display name", () => {
    const entityWithLabel = { ...registry, labels: ["matter_v2"] };
    const labels = [{ label_id: "matter_v2", name: "Matter" }];
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabelRegex,
          value: "^Matter$",
        },
        undefined,
        entityWithLabel,
        undefined,
        labels,
      ),
    ).toBeTruthy();
  });
  it("should match device label by regex", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["matter_room"] };
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceLabelRegex,
          value: "^matter_.*",
        },
        deviceWithLabel,
        entityWithoutLabel,
      ),
    ).toBeTruthy();
  });
  it("should not match device label regex against entity-only labels", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceLabelRegex,
          value: "^test_.*$",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should return false for invalid label regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.EntityLabelRegex,
          value: "[invalid(regex",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match any_field_regex against domain", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "domain=light",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match any_field_regex against manufacturer (#382)", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "manufacturer=Sonoff",
        },
        deviceRegistryWithManufacturer,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match any_field_regex with AND via lookahead", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "(?=.*domain=light)(?=.*platform=hue)",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match any_field_regex when AND group fails", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "(?=.*domain=light)(?=.*platform=zwave)",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should match any_field_regex with OR via alternation", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "domain=switch|domain=light",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match any_field_regex against entity label slug", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "entity_labels=.*\\btest_label\\b",
        },
        undefined,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match any_field_regex against device label display name", () => {
    const entityWithoutLabel = { ...registry, labels: [] };
    const deviceWithLabel = { ...deviceRegistry, labels: ["matter_v2"] };
    const labelRegistry = [{ label_id: "matter_v2", name: "Matter" }];
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "device_label_names=.*\\bMatter\\b",
        },
        deviceWithLabel,
        entityWithoutLabel,
        undefined,
        labelRegistry,
      ),
    ).toBeTruthy();
  });
  it("should match any_field_regex against area from device", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "area=area_id",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should return false for invalid any_field_regex", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.AnyFieldRegex,
          value: "[invalid(regex",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the device name", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Living Room",
        },
        deviceRegistryWithName,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match the device name case-insensitively", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "living room",
        },
        deviceRegistryWithName,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should prefer name_by_user over name", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Custom Light",
        },
        deviceRegistryWithUserName,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match if name_by_user doesn't contain the value", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Living Room",
        },
        deviceRegistryWithUserName,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should match the device name with wildcard pattern", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Living*Light",
        },
        deviceRegistryWithName,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match if device is undefined", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Living Room",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should not match if device has no name", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.DeviceName,
          value: "Living Room",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the product name", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "Hue Color",
        },
        deviceRegistryWithModel,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match the product name case-insensitively", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "hue color bulb",
        },
        deviceRegistryWithModel,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match the default_model if model is not set", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "Generic LED",
        },
        deviceRegistryWithDefaultModel,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match the product name with wildcard pattern", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "Hue*Bulb",
        },
        deviceRegistryWithModel,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match if device is undefined for product name", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "Hue",
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should not match if device has no model", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.ProductName,
          value: "Hue",
        },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should match the manufacturer (#382)", () => {
    expect(
      testMatcher(
        { type: HomeAssistantMatcherType.Manufacturer, value: "sonoff" },
        deviceRegistryWithManufacturer,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match the manufacturer with a wildcard", () => {
    expect(
      testMatcher(
        { type: HomeAssistantMatcherType.Manufacturer, value: "*onof*" },
        deviceRegistryWithManufacturer,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should match default_manufacturer if manufacturer is not set", () => {
    expect(
      testMatcher(
        { type: HomeAssistantMatcherType.Manufacturer, value: "Generic" },
        deviceRegistryWithDefaultManufacturer,
        registry,
      ),
    ).toBeTruthy();
  });
  it("should not match a different manufacturer", () => {
    expect(
      testMatcher(
        { type: HomeAssistantMatcherType.Manufacturer, value: "Philips" },
        deviceRegistryWithManufacturer,
        registry,
      ),
    ).toBeFalsy();
  });
  it("should not match manufacturer if device has none", () => {
    expect(
      testMatcher(
        { type: HomeAssistantMatcherType.Manufacturer, value: "Sonoff" },
        deviceRegistry,
        registry,
      ),
    ).toBeFalsy();
  });

  it("should return false for null matcher value", () => {
    expect(
      testMatcher(
        {
          type: HomeAssistantMatcherType.Pattern,
          value: null as unknown as string,
        },
        undefined,
        registry,
      ),
    ).toBeFalsy();
  });
});
