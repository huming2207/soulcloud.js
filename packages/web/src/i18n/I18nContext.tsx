import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { createTheme, type Theme } from "@mui/material/styles";
import {
  zhCN as muiZh,
  enUS as muiEn,
  ruRU as muiRu,
  ukUA as muiUk,
  itIT as muiIt,
} from "@mui/material/locale";
import {
  zhCN as gridZh,
  enUS as gridEn,
  ruRU as gridRu,
  ukUA as gridUk,
  itIT as gridIt,
} from "@mui/x-data-grid/locales";
import { baseTheme } from "../theme";
import { setStoredLocale } from "./index";
import type { DictKey, Locale } from "./dictionary";

const MUI_LOCALES = { zh: muiZh, en: muiEn, ru: muiRu, uk: muiUk, it: muiIt } as const;
const GRID_LOCALES = { zh: gridZh, en: gridEn, ru: gridRu, uk: gridUk, it: gridIt } as const;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: DictKey, params?: Record<string, string | number>) => string;
  /** MUI theme with the component locale applied (createTheme(base, locale)). */
  theme: Theme;
  /** Data Grid localeText for the current locale. */
  gridLocaleText: object;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Wires the app locale into the MUI component locale (createTheme's second
 * argument — the official Material UI localization mechanism) and into the
 * Data Grid locale. Application strings come from react-i18next via t().
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { i18n: instance, t: i18nT } = useTranslation();

  const locale: Locale = instance.language.startsWith("ru")
    ? "ru"
    : instance.language.startsWith("uk")
      ? "uk"
      : instance.language.startsWith("it")
        ? "it"
        : instance.language.startsWith("en")
          ? "en"
          : "zh";

  const setLocale = useCallback(
    (next: Locale) => {
      setStoredLocale(next);
      void instance.changeLanguage(next);
    },
    [instance],
  );

  const value = useMemo<I18nContextValue>(() => {
    const theme = createTheme(baseTheme, MUI_LOCALES[locale]);
    const gridLocaleText = GRID_LOCALES[locale].components.MuiDataGrid.defaultProps
      .localeText;
    return {
      locale,
      setLocale,
      theme,
      gridLocaleText,
      t: (key, params) => i18nT(key, params ? { ...params } : undefined) as string,
    };
  }, [locale, setLocale, i18nT]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** App strings (t) plus the MUI-aware theme and Data Grid locale. */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
