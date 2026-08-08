import fs from "node:fs";
import type { Argv } from "yargs";
import type { StartOptions } from "./start-options.js";

export function startOptionsBuilder(yargs: Argv): Argv<StartOptions> {
  return yargs
    .env("HAMH")
    .version(false)
    .config(
      "config",
      'Provide the path to a configuration JSON file, which can include all the other command options. You can use kebabcase ("log-level") or camelcase ("logLevel").',
      (configPath) => {
        if (configPath.trim() === "") {
          return {};
        }
        if (!fs.existsSync(configPath)) {
          throw new Error(`Config file '${configPath}' does not exist!`);
        }
        return JSON.parse(fs.readFileSync(configPath, "utf-8"));
      },
    )
    .option("log-level", {
      type: "string",
      choices: ["silly", "debug", "info", "notice", "warn", "error", "fatal"],
      default: "info",
    })
    .option("protocol-log-level", {
      type: "string",
      choices: ["silly", "debug", "info", "notice", "warn", "error", "fatal"],
      default: "info",
      description:
        "Log level for matter.js MessageChannel/MessageExchange facilities. These emit per-packet payloads at debug. Only lower it if you're debugging matter.js.",
    })
    .option("disable-log-colors", {
      type: "boolean",
      default: false,
    })
    .option("json-logs", {
      type: "boolean",
      default: false,
      description:
        "Output logs in JSON format for structured logging (useful for log aggregation systems)",
    })
    .option("storage-location", {
      type: "string",
      description:
        "Path to a directory where the application should store its data. Defaults to $HOME/.home-assistant-matter-hub",
    })
    .option("http-port", {
      alias: "web-port",
      type: "number",
      description:
        "Port used by the web application. 'http-port' is recommended, 'web-port' is deprecated and will be removed in the future.",
      default: 8482,
    })
    .option("http-ip-whitelist", {
      type: "array",
      description:
        "Only allow the specified IPv4, IPv6 or CIDR. You can specify this option multiple times. When configured via ENV variables, you can only specify ONE value. Defaults to allow every IP address.",
    })
    .option("mdns-disable-ipv4", {
      type: "boolean",
      default: false,
      description: "Disable IPv4 for mDNS, so only IPv6 will be used",
    })
    .option("mdns-network-interface", {
      type: "string",
      description: "Limit mDNS to this network interface",
    })
    .option("mdns-strip-global-ipv6", {
      type: "boolean",
      default: false,
      description:
        "Drop global IPv6 (GUA) from mDNS so controllers use a locally reachable address (#361)",
    })
    .option("home-assistant-url", {
      type: "string",
      description: "The HTTP-URL of your Home Assistant URL",
    })
    .option("home-assistant-access-token", {
      type: "string",
      description: "A long-lived access token for your Home Assistant Instance",
    })
    .option("home-assistant-refresh-interval", {
      type: "number",
      description:
        "The refresh rate (in seconds) to detect new devices & entities or their configurations",
      default: 60,
    })
    .option("ha-message-timeout", {
      type: "number",
      description:
        "Timeout in milliseconds for individual Home Assistant WebSocket requests (registry fetches, action calls). Raise this if you see 'HA message ... timed out' warnings on a large or slow HA instance.",
      default: 60_000,
    })
    .option("http-auth-username", {
      type: "string",
      description: "Username for HTTP basic authentication (optional)",
    })
    .option("http-auth-password", {
      type: "string",
      description: "Password for HTTP basic authentication (optional)",
    })
    .option("http-base-path", {
      type: "string",
      description:
        "Base path for the web interface and API when served behind a reverse proxy under a subfolder (e.g. /matter). Defaults to /",
    })
    .demandOption(["home-assistant-url", "home-assistant-access-token"]);
}
