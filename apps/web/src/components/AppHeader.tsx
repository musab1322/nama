"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Coins, CreditCard, Languages, LogOut, Settings, Sparkles } from "lucide-react";
import { useStrings } from "@/i18n/strings";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/index";
import { browserClient } from "@/lib/supabase/browser";
import { useLocale, useSwitchLocale, useT } from "@/i18n/client";

export function LanguageSwitch() {
  const t = useT();
  const switchLocale = useSwitchLocale();
  return (
    <Button variant="ghost" size="sm" onClick={switchLocale}>
      <Languages className="size-4" />
      <span className="max-sm:sr-only">{t("common.language")}</span>
    </Button>
  );
}

export function Credits({ balance }: { balance: number }) {
  const t = useT();
  const locale = useLocale();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm" title={t("dash.credits")}>
      <Coins className="size-4 text-warning" />
      <span className="font-medium">{balance.toLocaleString(locale)}</span>
      <span className="sr-only">{t("dash.credits")}</span>
    </span>
  );
}

export function AppHeader({ credits, children }: { credits: number; children?: ReactNode }) {
  const t = useT();
  const nav = useStrings({ ar: { plans: "الباقات", settings: "الإعدادات" }, en: { plans: "Plans", settings: "Settings" } });
  const router = useRouter();
  async function signOut() {
    await browserClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
      <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
        <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Sparkles className="size-4" />
        </span>
        <span className="max-sm:hidden">{t("app.name")}</span>
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <Link href="/billing" className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2 text-sm hover:bg-muted" title={nav.plans}>
        <CreditCard className="size-4" />
        <span className="max-md:sr-only">{nav.plans}</span>
      </Link>
      <Link href="/settings" className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2 text-sm hover:bg-muted" title={nav.settings}>
        <Settings className="size-4" />
        <span className="max-md:sr-only">{nav.settings}</span>
      </Link>
      <Credits balance={credits} />
      <LanguageSwitch />
      <Button variant="ghost" size="icon" onClick={signOut} aria-label={t("auth.signOut")} title={t("auth.signOut")}>
        <LogOut className="size-4 rtl:rotate-180" />
      </Button>
    </header>
  );
}
