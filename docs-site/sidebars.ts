import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "index",
    {
      type: "category",
      label: "Getting Started",
      items: [
        "getting-started/installation",
        "getting-started/bridge-configuration",
        "getting-started/standalone-devices",
        "getting-started/migration-from-t0bst4r",
        "getting-started/fork-comparison",
      ],
    },
    {
      type: "category",
      label: "Devices",
      link: { type: "doc", id: "supported-device-types" },
      items: [
        "devices/light",
        "devices/climate",
        "devices/cover",
        "devices/lock",
        "devices/robot-vacuum",
        "devices/air-purifier",
        "devices/temperature-humidity-sensor",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/connect-multiple-fabrics",
        "guides/alexa-bulk-delete-devices",
        "guides/reverse-proxy",
        "guides/alpha-features",
        "guides/testing-features",
      ],
    },
    {
      type: "category",
      label: "Plugins",
      items: ["guides/plugin-system"],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "guides/api-reference",
        "guides/controller-compatibility",
        "guides/mapping-blueprints",
      ],
    },
    {
      type: "category",
      label: "Troubleshooting",
      items: [
        "guides/connectivity-issues",
        "guides/low-resource-devices",
        "faq",
      ],
    },
    {
      type: "category",
      label: "Developer",
      items: [
        "developer/index",
        "developer/services",
        "developer/endpoints",
        "developer/behaviors",
      ],
    },
    "support",
  ],
};

export default sidebars;
