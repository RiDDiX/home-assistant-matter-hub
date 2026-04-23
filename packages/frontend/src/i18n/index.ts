import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import it from "./locales/it.json";
import pl from "./locales/pl.json";
import ru from "./locales/ru.json";
import sv from "./locales/sv.json";
import th from "./locales/th.json";
import tr from "./locales/tr.json";
import zh from "./locales/zh.json";
import zhTW from "./locales/zh-tw.json";

const STORAGE_KEY = "hamh-translation-overrides";
const CUSTOM_LANGS_KEY = "hamh-custom-languages";

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v as Record<string, unknown>, full));
    } else {
      result[full] = String(v ?? "");
    }
  }
  return result;
}

function unflattenObject(
  flat: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

function restoreOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, Record<string, string>>;
    for (const [lang, overrides] of Object.entries(all)) {
      if (!overrides || Object.keys(overrides).length === 0) continue;
      const base = i18n.getResourceBundle(lang, "translation") as
        | Record<string, unknown>
        | undefined;
      const baseFlat = base ? flattenObject(base) : {};
      const merged = { ...baseFlat, ...overrides };
      const nested = unflattenObject(merged);
      i18n.addResourceBundle(lang, "translation", nested, true, true);
    }
  } catch {
    // ignore storage errors
  }
}

function restoreCustomLanguages() {
  try {
    const raw = localStorage.getItem(CUSTOM_LANGS_KEY);
    if (!raw) return;
    const langs = JSON.parse(raw) as Array<{
      code: string;
      name: string;
    }>;
    for (const lang of langs) {
      if (!i18n.hasResourceBundle(lang.code, "translation")) {
        i18n.addResourceBundle(lang.code, "translation", {}, true, true);
      }
    }
  } catch {
    // ignore storage errors
  }
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      de: { translation: de },
      fr: { translation: fr },
      it: { translation: it },
      es: { translation: es },
      zh: { translation: zh },
      "zh-TW": { translation: zhTW },
      th: { translation: th },
      sv: { translation: sv },
      tr: { translation: tr },
      ru: { translation: ru },
      pl: { translation: pl },
    },
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
    },
  });

restoreCustomLanguages();
restoreOverrides();

export { CUSTOM_LANGS_KEY, STORAGE_KEY };
export default i18n;
