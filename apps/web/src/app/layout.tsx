import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic, Inter } from "next/font/google";
import { I18nProvider } from "@/i18n/client";
import { getLocale } from "@/i18n/server";
import { dirOf, translate } from "@/i18n/dict";
import "./globals.css";

const arabic = IBM_Plex_Sans_Arabic({ subsets: ["arabic"], weight: ["400", "500", "600", "700"], variable: "--font-arabic" });
const latin = Inter({ subsets: ["latin"], variable: "--font-latin" });

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return { title: translate(locale, "app.name"), description: translate(locale, "app.tagline") };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={dirOf(locale)} className={`${arabic.variable} ${latin.variable}`}>
      <body className="font-sans">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
