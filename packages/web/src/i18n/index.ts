import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, type Locale } from "./dictionary";

const LOCALE_KEY = "soulcloud.locale";

/** Stored locale, or the browser language when it is English/Russian/Ukrainian, else zh. */
function detectInitialLocale(): Locale {
  const stored = localStorage.getItem(LOCALE_KEY);
  if (stored === "zh" || stored === "en" || stored === "ru" || stored === "uk" || stored === "it") {
    return stored;
  }
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith("ru")) return "ru";
  if (lang.startsWith("uk")) return "uk";
  if (lang.startsWith("it")) return "it";
  if (lang.startsWith("en")) return "en";
  return "zh";
}

export function setStoredLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_KEY, locale);
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectInitialLocale(),
  fallbackLng: "zh",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
