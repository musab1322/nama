import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/i18n/dict";

export const LOCALE_COOKIE = "locale";

export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}
