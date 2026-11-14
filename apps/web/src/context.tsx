import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type Lang, savedLang, saveLang, type Translate, translator } from "./i18n.ts";

/** `system` follows the operating system's light or dark appearance. */
export type Theme = "system" | "light" | "dark";

interface I18nValue {
  lang: Lang;
  t: Translate;
  setLang(lang: Lang): void;
  theme: Theme;
  setTheme(theme: Theme): void;
}

const I18n = createContext<I18nValue>({
  lang: "zh",
  t: translator("zh"),
  setLang: () => {},
  theme: "system",
  setTheme: () => {},
});

const THEME_KEY = "warren.theme";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/** Interface preferences kept per browser: language and theme. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const [theme, setThemeState] = useState<Theme>(savedTheme);
  const value = useMemo<I18nValue>(
    () => ({
      lang,
      t: translator(lang),
      setLang(next) {
        saveLang(next);
        setLangState(next);
      },
      theme,
      setTheme(next) {
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // Without storage the choice lasts until the page reloads.
        }
        setThemeState(next);
      },
    }),
    [lang, theme],
  );
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18n);
}

/** The current time, refreshed every `ms` while `live`, for elapsed-time displays. */
export function useNow(live: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [live, ms]);
  return now;
}
