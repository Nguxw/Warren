import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { type Lang, savedLang, saveLang, type Translate, translator } from "./i18n.ts";

interface I18nValue {
  lang: Lang;
  t: Translate;
  setLang(lang: Lang): void;
}

const I18n = createContext<I18nValue>({ lang: "zh", t: translator("zh"), setLang: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(savedLang);
  const value = useMemo<I18nValue>(
    () => ({
      lang,
      t: translator(lang),
      setLang(next) {
        saveLang(next);
        setLangState(next);
      },
    }),
    [lang],
  );
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
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
