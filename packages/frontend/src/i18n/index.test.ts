import { afterEach, describe, expect, it } from "vitest";
import i18n, { applyTranslationOverrides, bundledResources } from "./index.ts";

describe("applyTranslationOverrides", () => {
  afterEach(() => {
    applyTranslationOverrides("de", {});
  });

  it("applies an edit without touching the shipped texts", () => {
    const shipped = i18n.t("common.save", { lng: "de" });

    applyTranslationOverrides("de", { "common.save": "Sichern" });

    expect(i18n.t("common.save", { lng: "de" })).toBe("Sichern");
    expect(
      (bundledResources.de?.translation.common as Record<string, string>).save,
    ).toBe(shipped);
  });

  it("puts the shipped text back on reset", () => {
    const shipped = i18n.t("common.save", { lng: "de" });
    applyTranslationOverrides("de", { "common.save": "Sichern" });

    applyTranslationOverrides("de", {});

    expect(i18n.t("common.save", { lng: "de" })).toBe(shipped);
  });

  it("falls back to English after a reset in a custom language", () => {
    i18n.addResourceBundle("eo", "translation", {});
    applyTranslationOverrides("eo", { "common.save": "Konservi" });
    expect(i18n.t("common.save", { lng: "eo" })).toBe("Konservi");

    applyTranslationOverrides("eo", {});

    expect(i18n.t("common.save", { lng: "eo" })).toBe("Save");
  });
});
