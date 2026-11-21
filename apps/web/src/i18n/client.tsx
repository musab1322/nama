"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { translate, type Locale, type MessageKey } from "@/i18n/dict";

const I18nContext = createContext<Locale>("ar");

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext.Provider value={locale}>{children}</I18nContext.Provider>;
}

export function useLocale() {
  return useContext(I18nContext);
}

export function useT() {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );
}

export function useSwitchLocale() {
  const router = useRouter();
  const locale = useLocale();
  return useCallback(() => {
    const next: Locale = locale === "ar" ? "en" : "ar";
    document.cookie = `locale=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [locale, router]);
}

/** Locale-aware relative time, e.g. "قبل ٥ دقائق" / "5 minutes ago". */
export function useRelativeTime() {
  const locale = useLocale();
  return useCallback(
    (iso: string) => {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
      const diff = (Date.parse(iso) - Date.now()) / 1000;
      const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1],
      ];
      for (const [unit, secs] of units) {
        if (Math.abs(diff) >= secs || unit === "second") return rtf.format(Math.round(diff / secs), unit);
      }
      return "";
    },
    [locale],
  );
}
