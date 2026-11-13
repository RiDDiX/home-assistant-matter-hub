import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import de from "./locales/de.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import hu from "./locales/hu.json";
import it from "./locales/it.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import nl from "./locales/nl.json";
import pl from "./locales/pl.json";
import ptBR from "./locales/pt-br.json";
import ru from "./locales/ru.json";
import sv from "./locales/sv.json";
import th from "./locales/th.json";
import tr from "./locales/tr.json";
import vi from "./locales/vi.json";
import zh from "./locales/zh.json";
import zhTW from "./locales/zh-tw.json";

const STORAGE_KEY = "hamh-translation-overrides";
const CUSTOM_LANGS_KEY = "hamh-custom-languages";

export function flattenObject(
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

const unsafeKeyParts = new Set(["__proto__", "constructor", "prototype"]);

export function unflattenObject(
  flat: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    // keys come from imported files and storage, keep them off the prototype
    if (parts.some((p) => unsafeKeyParts.has(p))) continue;
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      // inherited members are functions, never walk into them
      if (typeof current[parts[i]] !== "object") {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

// Shipped texts plus local edits. The bundle is replaced, not merged, so a
// reset key falls back to the shipped text again.
export function applyTranslationOverrides(
  lang: string,
  overrides: Record<string, string>,
) {
  const merged = flattenObject(bundledResources[lang]?.translation ?? {});
  for (const [key, value] of Object.entries(overrides)) {
    if (value) merged[key] = value;
  }
  i18n.removeResourceBundle(lang, "translation");
  i18n.addResourceBundle(lang, "translation", unflattenObject(merged));
}

function restoreOverrides() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as Record<string, Record<string, string>>;
    for (const [lang, overrides] of Object.entries(all)) {
      if (!overrides || Object.keys(overrides).length === 0) continue;
      applyTranslationOverrides(lang, overrides);
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

const resources = {
  en: { translation: en },
  de: { translation: de },
  hu: { translation: hu },
  fr: { translation: fr },
  it: { translation: it },
  ja: { translation: ja },
  ko: { translation: ko },
  es: { translation: es },
  zh: { translation: zh },
  "zh-TW": { translation: zhTW },
  th: { translation: th },
  sv: { translation: sv },
  tr: { translation: tr },
  ru: { translation: ru },
  nl: { translation: nl },
  pl: { translation: pl },
  "pt-BR": { translation: ptBR },
  vi: { translation: vi },
};

// The switcher and the translation editor list these.
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "hu", name: "Magyar" },
  { code: "pl", name: "Polski" },
  { code: "zh", name: "中文" },
  { code: "zh-TW", name: "繁體中文" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "th", name: "ไทย" },
  { code: "nl", name: "Nederlands" },
  { code: "sv", name: "Svenska" },
  { code: "tr", name: "Türkçe" },
  { code: "ru", name: "Русский" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "vi", name: "Tiếng Việt" },
];

// The shipped texts without local edits. i18next merges edits into the
// object it gets, so it gets a copy.
export const bundledResources: Record<
  string,
  { translation: Record<string, unknown> } | undefined
> = resources;

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: structuredClone(resources),
    fallbackLng: "en",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
    },
    // re-render on bundle changes so translation edits show up live
    react: { bindI18nStore: "added removed" },
  });

restoreCustomLanguages();
restoreOverrides();

export { STORAGE_KEY, CUSTOM_LANGS_KEY };
export default i18n;
