import { describe, expect, it } from "vitest";
import type { OptionsProps } from "./options.js";
import { Options } from "./options.js";

function buildOptions(overrides: Partial<OptionsProps> = {}): Options {
  const base = {
    httpPort: 8482,
    homeAssistantUrl: "http://homeassistant:8123",
    homeAssistantAccessToken: "token",
    homeAssistantRefreshInterval: 0,
    haMessageTimeout: 10000,
    webUiDist: undefined,
    storageLocation: undefined,
    ...overrides,
  } as unknown as OptionsProps;
  return new Options(base);
}

describe("Options mDNS IPv4", () => {
  it("keeps IPv4 mDNS on by default", () => {
    expect(buildOptions().mdns.ipv4).toBe(true);
  });

  it("turns IPv4 mDNS off when mdnsDisableIpv4 is set", () => {
    expect(buildOptions({ mdnsDisableIpv4: true }).mdns.ipv4).toBe(false);
  });

  it("mirrors mdns.ipv4 in the web API props", () => {
    expect(buildOptions().webApi.mdnsIpv4).toBe(true);
    expect(buildOptions({ mdnsDisableIpv4: true }).webApi.mdnsIpv4).toBe(false);
  });
});
