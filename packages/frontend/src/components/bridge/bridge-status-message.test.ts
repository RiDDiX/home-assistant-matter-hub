import i18n from "i18next";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeStatusMessage } from "./bridge-status-message.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("bridgeStatusMessage", () => {
  it("keeps the backend English text in English", () => {
    for (const reason of [
      "Manually stopped",
      "Factory reset",
      "The bridge is starting... Please wait.",
      "The server mode bridge is starting... Please wait.",
      "something new",
    ]) {
      expect(bridgeStatusMessage(reason, i18n.t)).toBe(reason);
    }
    expect(
      bridgeStatusMessage(
        "Failed to start server mode bridge due to error:\nError: boom",
        i18n.t,
      ),
    ).toBe("Failed to start server mode bridge due to error: Error: boom");
  });

  it("translates known reasons and keeps the error detail", async () => {
    await i18n.addResourceBundle(
      "de",
      "translation",
      {
        bridgeUi: { updateFailed: "Update fehlgeschlagen: {{error}}" },
      },
      true,
      true,
    );
    await i18n.changeLanguage("de");
    expect(
      bridgeStatusMessage(
        "Failed to update bridge due to error:\nError: boom",
        i18n.t,
      ),
    ).toBe("Update fehlgeschlagen: Error: boom");
  });
});
