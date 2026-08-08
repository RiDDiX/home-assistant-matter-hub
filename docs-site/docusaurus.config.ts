import type { Options as ClientRedirectsOptions } from "@docusaurus/plugin-client-redirects";
import type * as Preset from "@docusaurus/preset-classic";
import type { Config } from "@docusaurus/types";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "Home Assistant Matter Hub",
  tagline: "Expose Home Assistant devices as Matter devices",
  favicon: "img/hamh-logo-small.png",

  url: "https://riddix.github.io",
  baseUrl: "/home-assistant-matter-hub/",

  organizationName: "riddix",
  projectName: "home-assistant-matter-hub",

  onBrokenLinks: "throw",
  trailingSlash: false,

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl:
            "https://github.com/riddix/home-assistant-matter-hub/tree/main/docs-site/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: ["docusaurus-lunr-search"],

  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: [
          { from: "/installation", to: "/getting-started/installation" },
          {
            from: "/bridge-configuration",
            to: "/getting-started/bridge-configuration",
          },
          { from: "/alpha-features", to: "/guides/alpha-features" },
          { from: "/testing-features", to: "/guides/testing-features" },
          { from: "/api-reference", to: "/guides/api-reference" },
          {
            from: "/migration-from-t0bst4r",
            to: "/getting-started/migration-from-t0bst4r",
          },
          { from: "/fork-comparison", to: "/getting-started/fork-comparison" },
          { from: "/connectivity-issues", to: "/guides/connectivity-issues" },
          {
            from: "/connect-multiple-fabrics",
            to: "/guides/connect-multiple-fabrics",
          },
          { from: "/reverse-proxy", to: "/guides/reverse-proxy" },
          { from: "/plugin-system", to: "/guides/plugin-system" },
          { from: "/light", to: "/devices/light" },
          { from: "/climate", to: "/devices/climate" },
          { from: "/cover", to: "/devices/cover" },
          { from: "/lock", to: "/devices/lock" },
          { from: "/robot-vacuum", to: "/devices/robot-vacuum" },
          { from: "/air-purifier", to: "/devices/air-purifier" },
          {
            from: "/temperature-humidity-sensor",
            to: "/devices/temperature-humidity-sensor",
          },
          { from: "/frequently-asked-questions", to: "/faq" },
          { from: "/services", to: "/developer/services" },
          { from: "/endpoints", to: "/developer/endpoints" },
          { from: "/behaviors", to: "/developer/behaviors" },
          // Old Docusaurus paths before restructure
          {
            from: "/guides/migration-from-t0bst4r",
            to: "/getting-started/migration-from-t0bst4r",
          },
        ],
      } satisfies ClientRedirectsOptions,
    ],
  ],

  themeConfig: {
    image: "img/hamh-logo-large.png",
    metadata: [
      {
        name: "description",
        content:
          "Actively maintained fork and successor of t0bst4r/home-assistant-matter-hub. Expose Home Assistant devices to Matter controllers like Apple Home, Google Home, and Alexa.",
      },
      {
        name: "keywords",
        content:
          "home assistant, matter, bridge, t0bst4r, fork, successor, hamh, apple home, google home, alexa",
      },
    ],
    navbar: {
      title: "Home Assistant Matter Hub",
      logo: {
        alt: "HAMH Logo",
        src: "img/hamh-logo-small.png",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Documentation",
        },
        {
          href: "https://github.com/riddix/home-assistant-matter-hub",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Getting Started", to: "/getting-started/installation" },
            { label: "Devices", to: "/supported-device-types" },
            { label: "Plugins", to: "/guides/plugin-system" },
            { label: "API Reference", to: "/guides/api-reference" },
          ],
        },
        {
          title: "Help",
          items: [
            { label: "Troubleshooting", to: "/guides/connectivity-issues" },
            { label: "FAQ", to: "/faq" },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "GitHub Issues",
              href: "https://github.com/riddix/home-assistant-matter-hub/issues",
            },
            {
              label: "GitHub Discussions",
              href: "https://github.com/riddix/home-assistant-matter-hub/discussions",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Home Assistant Matter Hub`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
