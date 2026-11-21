"use client";

import { useLocale } from "@/i18n/client";

/**
 * Screen-local strings: each screen keeps its Arabic and English text side by side,
 * and English must have every Arabic key (checked by the type).
 */
export function useStrings<T extends Record<string, string>>(s: { ar: T; en: { [K in keyof T]: string } }) {
  return s[useLocale()];
}

/** "{n} ريال" style money from halalas, in the current locale. */
export function useSar() {
  const locale = useLocale();
  return (halalas: number) =>
    new Intl.NumberFormat(locale === "ar" ? "ar-SA-u-nu-latn" : "en-SA", { style: "currency", currency: "SAR", maximumFractionDigits: 2 }).format(halalas / 100);
}

export const fill = (s: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), s);
