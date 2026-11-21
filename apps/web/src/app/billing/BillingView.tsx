"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Coins, HeartHandshake, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { MoyasarForm, type MoyasarConfig } from "@/components/billing/MoyasarForm";
import { Alert, Badge, Button, Card, Dialog, cn } from "@/components/ui/index";
import { api, ApiError } from "@/lib/api-client";
import { useLocale } from "@/i18n/client";
import { fill, useSar, useStrings } from "@/i18n/strings";

export interface PlanRow {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  price_halalas: number;
  billing_interval: "month" | "year" | null;
  monthly_credits: number;
  max_published_apps: number;
  features: { stores?: boolean; custom_domain?: boolean; code_export?: boolean; addon?: string; credit_pack?: boolean };
  charity_discount_pct: number;
}

export interface SubscriptionView {
  status: "trialing" | "active" | "past_due";
  plan_id: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  cancel_at_period_end: boolean;
  extra_apps: number;
}

const S = {
  ar: {
    title: "الباقات والفوترة",
    current: "باقتك الحالية",
    free: "المجانية: معاينة فقط، دون نشر",
    renews: "تتجدد في {date}",
    ends: "تنتهي في {date} ولن تتجدد",
    pastDue: "تعذّر تجديد الدفع. حدّث بطاقتك قبل {date} حتى لا تتوقف تطبيقاتك المنشورة.",
    cancel: "إيقاف التجديد",
    cancelConfirm: "ستبقى باقتك حتى نهاية الفترة المدفوعة ثم تتوقف. تطبيقاتك المنشورة تتوقف بعد مهلة السماح، وبياناتها محفوظة 90 يوماً.",
    cancelYes: "نعم، أوقف التجديد",
    perMonth: "شهرياً",
    oneOff: "مرة واحدة",
    credits: "{n} رصيد شهرياً",
    creditPack: "{n} رصيد",
    apps: "تطبيقات منشورة: {n}",
    extraTitle: "تطبيق منشور إضافي",
    extraNote: "يُضاف إلى تجديدك الشهري. تحتاجه لنشر تطبيق جديد بعد أن تمتلئ تطبيقات باقتك.",
    extraUsage: "تطبيقاتك المنشورة: {used} من {limit}",
    extraOwned: "تطبيقات إضافية: {n}",
    extraAdd: "أضف تطبيقاً",
    extraRemove: "أزل تطبيقاً إضافياً",
    extraRemoveNote: "يتوقف من التجديد القادم ولا يُسترد ما دُفع. لا يمكن إزالته وكل التطبيقات مستخدمة.",
    stores: "النشر على App Store وGoogle Play",
    domain: "نطاق خاص",
    export: "تصدير الكود",
    web: "النشر على الويب",
    preview: "معاينة كاملة داخل المتصفح",
    choose: "اشترك",
    buy: "اشترِ",
    yours: "باقتك",
    charity: "سعر الجمعيات الموثّقة",
    charityHint: "جمعية أهلية مرخّصة؟ وثّق جمعيتك من الإعدادات واحصل على خصم {pct}%.",
    settings: "الإعدادات",
    pay: "إتمام الدفع",
    payNote: "الدفع عبر Moyasar (مدى، فيزا، ماستركارد، Apple Pay، STC Pay). بيانات البطاقة لا تمر بخوادمنا.",
    saveCard: "تُحفظ البطاقة لدى Moyasar للتجديد الشهري، ويمكنك إيقافه متى شئت.",
    "status.paid": "تم الدفع بنجاح.",
    "status.pending": "نتأكد من الدفع الآن. ستتحدّث الصفحة خلال دقائق.",
    "status.failed": "لم يكتمل الدفع، ولم يُخصم شيء. حاول مرة أخرى.",
    balance: "رصيدك",
    error: "حدث خطأ. حاول مرة أخرى.",
  },
  en: {
    title: "Plans and billing",
    current: "Your plan",
    free: "Free: preview only, no publishing",
    renews: "Renews on {date}",
    ends: "Ends on {date} and won't renew",
    pastDue: "We couldn't renew your payment. Update your card before {date} so your published apps keep running.",
    cancel: "Stop renewal",
    cancelConfirm: "Your plan stays until the end of the paid period, then stops. Published apps stop after the grace period; their data is kept for 90 days.",
    cancelYes: "Yes, stop renewal",
    perMonth: "per month",
    oneOff: "one-off",
    credits: "{n} credits a month",
    creditPack: "{n} credits",
    apps: "Published apps: {n}",
    extraTitle: "Extra published app",
    extraNote: "Added to your monthly renewal. You need one to publish a new app once your plan's apps are in use.",
    extraUsage: "Your published apps: {used} of {limit}",
    extraOwned: "Extra apps: {n}",
    extraAdd: "Add an app",
    extraRemove: "Remove an extra app",
    extraRemoveNote: "It stops from the next renewal; what was paid is not refunded. Not possible while every app is in use.",
    stores: "Publish to the App Store and Google Play",
    domain: "Custom domain",
    export: "Code export",
    web: "Publish on the web",
    preview: "Full in-browser preview",
    choose: "Subscribe",
    buy: "Buy",
    yours: "Your plan",
    charity: "Verified charity price",
    charityHint: "A licensed charity? Verify it in settings for a {pct}% discount.",
    settings: "Settings",
    pay: "Payment",
    payNote: "Payments go through Moyasar (mada, Visa, Mastercard, Apple Pay, STC Pay). Card details never touch our servers.",
    saveCard: "Your card is saved with Moyasar for the monthly renewal; you can stop it any time.",
    "status.paid": "Payment successful.",
    "status.pending": "We're confirming the payment. This page updates within minutes.",
    "status.failed": "The payment didn't complete and nothing was charged. Try again.",
    balance: "Your credits",
    error: "Something went wrong. Try again.",
  },
};

export function BillingView({
  plans,
  subscription,
  credits,
  verifiedCharity,
  returnStatus,
  publishedApps,
}: {
  plans: PlanRow[];
  subscription: SubscriptionView | null;
  credits: number;
  verifiedCharity: boolean;
  publishedApps: number;
  returnStatus: "paid" | "pending" | "failed" | null;
}) {
  const s = useStrings(S);
  const locale = useLocale();
  const sar = useSar();
  const router = useRouter();
  const [checkout, setCheckout] = useState<{ plan: PlanRow; form: MoyasarConfig } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB", { dateStyle: "long" }) : "");
  const priceFor = (p: PlanRow) => (verifiedCharity ? Math.floor((p.price_halalas * (100 - p.charity_discount_pct)) / 100) : p.price_halalas);
  const currentPlan = plans.find((p) => p.id === subscription?.plan_id);
  const subscriptions = plans.filter((p) => p.billing_interval);
  const packs = plans.filter((p) => !p.billing_interval && p.price_halalas > 0 && !p.features.addon);
  const extraApp = plans.find((p) => p.features.addon === "extra_app");
  const appLimit = (currentPlan?.max_published_apps ?? 0) + (subscription?.extra_apps ?? 0);
  const maxDiscount = Math.max(0, ...plans.map((p) => p.charity_discount_pct));

  async function start(plan: PlanRow) {
    setBusy(plan.code);
    setError(null);
    try {
      const res = await api<{ form: MoyasarConfig }>("/api/billing/checkout", { body: { planCode: plan.code } });
      setCheckout({ plan, form: res.form });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : s.error);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api("/api/billing/cancel", { body: {} });
      setConfirmCancel(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : s.error);
    } finally {
      setBusy(null);
    }
  }

  async function removeExtra() {
    setBusy("remove-extra");
    setError(null);
    try {
      await api("/api/billing/extra-apps", { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : s.error);
    } finally {
      setBusy(null);
    }
  }

  const feature = (on: boolean | undefined, label: string) => (
    <li className={cn("flex items-start gap-2", !on && "text-muted-foreground line-through")}>
      <Check className={cn("mt-0.5 size-4 shrink-0", on ? "text-primary" : "opacity-40")} />
      {label}
    </li>
  );

  return (
    <div className="min-h-dvh">
      <AppHeader credits={credits} />
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8">
        <h1 className="text-2xl font-semibold">{s.title}</h1>
        {returnStatus && <Alert tone={returnStatus === "paid" ? "success" : returnStatus === "pending" ? "info" : "danger"}>{s[`status.${returnStatus}`]}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}

        <Card className="flex flex-wrap items-center gap-3 p-5">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm text-muted-foreground">{s.current}</p>
            <p className="text-lg font-semibold">{currentPlan ? (locale === "ar" ? currentPlan.name_ar : currentPlan.name_en) : s.free}</p>
            {subscription?.status === "past_due" && <Alert tone="warning">{fill(s.pastDue, { date: date(subscription.grace_until) })}</Alert>}
            {subscription && subscription.status !== "past_due" && (
              <p className="text-sm text-muted-foreground">
                {fill(subscription.cancel_at_period_end ? s.ends : s.renews, { date: date(subscription.current_period_end) })}
              </p>
            )}
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm">
            <Coins className="size-4 text-warning" />
            {s.balance}: <strong>{credits.toLocaleString(locale)}</strong>
          </span>
          {subscription && !subscription.cancel_at_period_end && subscription.status !== "past_due" && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)}>{s.cancel}</Button>
          )}
        </Card>

        {!verifiedCharity && maxDiscount > 0 && (
          <Alert tone="info" className="flex items-center gap-2">
            <HeartHandshake className="size-4 shrink-0" />
            <span>
              {fill(s.charityHint, { pct: maxDiscount })} <Link href="/settings" className="underline">{s.settings}</Link>
            </span>
          </Alert>
        )}

        <section className="grid gap-4 md:grid-cols-3">
          <Card className="space-y-4 p-5">
            <h2 className="text-lg font-semibold">{locale === "ar" ? "مجانية" : "Free"}</h2>
            <p className="text-2xl font-bold">{sar(0)}</p>
            <ul className="space-y-2 text-sm">
              {feature(true, s.preview)}
              {feature(false, s.web)}
              {feature(false, s.stores)}
            </ul>
          </Card>
          {subscriptions.filter((p) => p.price_halalas > 0).map((p) => {
            const mine = p.id === subscription?.plan_id;
            const price = priceFor(p);
            return (
              <Card key={p.id} className={cn("space-y-4 p-5", mine && "border-primary ring-2 ring-primary/30")}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">{locale === "ar" ? p.name_ar : p.name_en}</h2>
                  {mine && <Badge tone="success">{s.yours}</Badge>}
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {sar(price)} <span className="text-sm font-normal text-muted-foreground">{s.perMonth}</span>
                  </p>
                  {verifiedCharity && price < p.price_halalas && (
                    <p className="text-xs text-primary">
                      {s.charity} <span className="text-muted-foreground line-through">{sar(p.price_halalas)}</span>
                    </p>
                  )}
                </div>
                <ul className="space-y-2 text-sm">
                  {feature(true, s.web)}
                  {feature(p.features.stores, s.stores)}
                  {feature(true, fill(s.credits, { n: p.monthly_credits }))}
                  {feature(true, fill(s.apps, { n: p.max_published_apps }))}
                  {feature(p.features.custom_domain, s.domain)}
                  {feature(p.features.code_export, s.export)}
                </ul>
                <Button className="w-full" variant={mine ? "outline" : "primary"} onClick={() => start(p)} loading={busy === p.code} disabled={mine && subscription?.status !== "past_due"}>
                  {mine ? s.yours : s.choose}
                </Button>
              </Card>
            );
          })}
        </section>

        {subscription && currentPlan && extraApp && (
          <Card className="flex flex-wrap items-center gap-4 p-5">
            <Plus className="size-6 text-primary" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium">
                {s.extraTitle} · {sar(priceFor(extraApp))} <span className="text-sm font-normal text-muted-foreground">{s.perMonth}</span>
              </p>
              <p className="text-sm text-muted-foreground">{s.extraNote}</p>
              <p className="text-sm">
                {fill(s.extraUsage, { used: publishedApps, limit: appLimit })}
                {subscription.extra_apps > 0 && <span className="text-muted-foreground"> · {fill(s.extraOwned, { n: subscription.extra_apps })}</span>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {subscription.extra_apps > 0 && (
                <Button size="sm" variant="ghost" title={s.extraRemoveNote} onClick={removeExtra} loading={busy === "remove-extra"} disabled={publishedApps >= appLimit}>
                  {s.extraRemove}
                </Button>
              )}
              <Button size="sm" onClick={() => start(extraApp)} loading={busy === extraApp.code} disabled={subscription.status === "past_due"}>
                {s.extraAdd}
              </Button>
            </div>
          </Card>
        )}

        {packs.length > 0 && (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {packs.map((p) => (
              <Card key={p.id} className="flex items-center gap-4 p-4">
                <Coins className="size-6 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{fill(s.creditPack, { n: p.monthly_credits })}</p>
                  <p className="text-sm text-muted-foreground">
                    {sar(priceFor(p))} · {s.oneOff}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => start(p)} loading={busy === p.code}>{s.buy}</Button>
              </Card>
            ))}
          </section>
        )}
      </main>

      <Dialog open={!!checkout} onClose={() => setCheckout(null)} title={s.pay}>
        {checkout && (
          <div className="space-y-4">
            <p className="font-medium">
              {locale === "ar" ? checkout.plan.name_ar : checkout.plan.name_en} · {sar(checkout.form.amount)}
            </p>
            <p className="text-xs text-muted-foreground">{s.payNote}</p>
            {checkout.form.credit_card.save_card && <p className="text-xs text-muted-foreground">{s.saveCard}</p>}
            <MoyasarForm config={checkout.form} />
          </div>
        )}
      </Dialog>

      <Dialog open={confirmCancel} onClose={() => setConfirmCancel(false)} title={s.cancel}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed">{s.cancelConfirm}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmCancel(false)}>{locale === "ar" ? "تراجع" : "Keep it"}</Button>
            <Button variant="danger" onClick={cancel} loading={busy === "cancel"}>{s.cancelYes}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
