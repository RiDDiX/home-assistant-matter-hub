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

describe("Options HTTP auth", () => {
  it("builds auth when username and password are set", () => {
    const options = buildOptions({
      httpAuthUsername: "hamh",
      httpAuthPassword: "pw",
    });
    expect(options.webApi.auth).toEqual({ username: "hamh", password: "pw" });
  });

  it("runs without auth when neither is set", () => {
    expect(buildOptions().webApi.auth).toBeUndefined();
    expect(
      buildOptions({ httpAuthUsername: "", httpAuthPassword: "" }).webApi.auth,
    ).toBeUndefined();
  });

  it("refuses to start with only a username", () => {
    expect(() => buildOptions({ httpAuthUsername: "hamh" })).toThrow(
      /HAMH_HTTP_AUTH_USERNAME and HAMH_HTTP_AUTH_PASSWORD/,
    );
  });

  it("refuses to start with only a password", () => {
    expect(() => buildOptions({ httpAuthPassword: "pw" })).toThrow(
      /http-auth-username and http-auth-password/,
    );
  });

  it("treats an empty password as not set", () => {
    expect(() =>
      buildOptions({ httpAuthUsername: "hamh", httpAuthPassword: "" }),
    ).toThrow(/only one of them is set/);
  });
});
