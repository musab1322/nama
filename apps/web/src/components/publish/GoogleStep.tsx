"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Users } from "lucide-react";
import { accountGuide, closedTestProgress, CLOSED_TEST_DAYS, CLOSED_TEST_TESTERS } from "@banna/policy/account-guide";
import { Alert, Button, Field, Input, Segmented } from "@/components/ui/index";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiError } from "@/lib/api-client";
import { useLocale } from "@/i18n/client";
import { fill, useStrings } from "@/i18n/strings";

export interface GoogleAccount {
  id: string;
  display_name: string;
  play_account_type: "personal" | "organization" | null;
  play_production_access: boolean | null;
  closedTestStartedAt?: string | null;
}

/** The customer's own verified Google Play account (FR-006a), and when its closed test began. */
export async function loadGoogleAccount(): Promise<GoogleAccount | null> {
  const { data } = await browserClient()
    .from("publisher_accounts")
    .select("id, display_name, play_account_type, play_production_access")
    .eq("platform", "android")
    .eq("kind", "customer")
    .eq("status", "verified")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const { data: app } = await browserClient()
    .from("mobile_apps")
    .select("play_closed_test_started_at")
    .eq("platform", "android")
    .not("play_closed_test_started_at", "is", null)
    .order("play_closed_test_started_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return { ...(data as GoogleAccount), closedTestStartedAt: (app?.play_closed_test_started_at as string | null) ?? null };
}

const S = {
  ar: {
    intro: "يُنشر تطبيقك على Google Play باسمك، من حسابك أنت كمطوّر. نحتاج مفتاح وصول (حساب خدمة) لنرفع الإصدارات نيابة عنك.",
    type: "نوع حسابك في Google Play",
    personal: "شخصي",
    organization: "منظمة أو شركة",
    createdOn: "تاريخ إنشاء الحساب",
    createdHint: "الحسابات الشخصية المنشأة من 13 نوفمبر 2023 تحتاج اختباراً مغلقاً قبل النشر للجميع.",
    name: "اسم المطوّر كما يظهر في Google Play",
    developerId: "رقم المطوّر (الرقم في رابط Play Console)",
    key: "ملف مفتاح حساب الخدمة (JSON)",
    connect: "ربط الحساب",
    connected: "حساب Google Play متصل",
    guide: "خطوات التجهيز",
    "err.google_key_invalid": "هذا ليس ملف مفتاح حساب خدمة. نزّله من Google Cloud كما هو.",
    "err.google_key_rejected": "رفضت Google هذا المفتاح. أنشئ مفتاحاً جديداً لحساب الخدمة وحاول مرة أخرى.",
    error: "حدث خطأ. حاول مرة أخرى.",
    back: "السابق",
    next: "التالي",
    ctTitle: "الاختبار المغلق مطلوب قبل النشر للجميع",
    ctBody: "حسابك الشخصي جديد، فتشترط Google اختباراً مغلقاً مع {testers} مختبِراً على الأقل لمدة {days} يوماً متتالية، ثم تطلب صلاحية النشر للجميع من Play Console. رفعنا الإصدار إلى مسار الاختبار المغلق.",
    ctProgress: "مضى {done} من {days} يوماً",
    ctReady: "اكتملت المدة. اطلب صلاحية الإنتاج من Play Console، ثم أخبرنا لننشر للجميع.",
    ctHow: "كيف أضيف المختبِرين؟",
  },
  en: {
    intro: "Your app is published on Google Play under your name, from your own developer account. We need an access key (service account) to upload releases for you.",
    type: "Your Google Play account type",
    personal: "Personal",
    organization: "Organization",
    createdOn: "Account creation date",
    createdHint: "Personal accounts created on or after 13 Nov 2023 need a closed test before publishing to everyone.",
    name: "Developer name shown on Google Play",
    developerId: "Developer ID (the number in your Play Console URL)",
    key: "Service account key file (JSON)",
    connect: "Connect",
    connected: "Google Play account connected",
    guide: "Setup steps",
    "err.google_key_invalid": "This is not a service account key file. Download it from Google Cloud as is.",
    "err.google_key_rejected": "Google rejected this key. Create a new key for the service account and try again.",
    error: "Something went wrong. Try again.",
    back: "Back",
    next: "Next",
    ctTitle: "A closed test is required before publishing to everyone",
    ctBody: "Your personal account is new, so Google requires a closed test with at least {testers} testers for {days} days in a row; then you apply for production access in Play Console. We uploaded the release to the closed testing track.",
    ctProgress: "{done} of {days} days done",
    ctReady: "The period is complete. Apply for production access in Play Console, then tell us to publish to everyone.",
    ctHow: "How do I add testers?",
  },
};

export function GoogleStep({
  account,
  onConnected,
  onNext,
  onBack,
}: {
  account: GoogleAccount | null | undefined;
  onConnected: (a: GoogleAccount) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const s = useStrings(S);
  const locale = useLocale();
  const [type, setType] = useState<"personal" | "organization">("organization");
  const [form, setForm] = useState({ displayName: "", developerId: "", accountCreatedOn: "", serviceAccountJson: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (account === undefined) return null;
  if (account) {
    return (
      <div className="space-y-4">
        <Alert tone="success" className="flex items-center gap-2">
          <CheckCircle2 className="size-4" />
          {s.connected}: <strong>{account.display_name}</strong>
        </Alert>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onBack}>{s.back}</Button>
          <Button onClick={onNext}>{s.next}</Button>
        </div>
      </div>
    );
  }

  const guide = accountGuide("google", type === "personal" ? "individual" : "organization");

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ publisher: GoogleAccount }>("/api/publisher-accounts/google", {
        body: {
          displayName: form.displayName.trim(),
          developerId: form.developerId.trim(),
          accountType: type,
          ...(form.accountCreatedOn ? { accountCreatedOn: form.accountCreatedOn } : {}),
          serviceAccountJson: form.serviceAccountJson,
        },
      });
      onConnected({ ...res.publisher, play_account_type: type });
    } catch (err) {
      if (err instanceof ApiError) {
        const key = `err.${err.code}` as keyof typeof s;
        setError(key in s ? s[key] : err.message);
      } else setError(s.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={connect} className="space-y-4">
      <p className="text-sm">{s.intro}</p>
      <Segmented
        label={s.type}
        value={type}
        onChange={setType}
        options={[
          { value: "organization", label: s.organization },
          { value: "personal", label: s.personal },
        ]}
      />
      <details className="rounded-xl border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">{s.guide}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{locale === "ar" ? guide.feeNote.ar : guide.feeNote.en}</p>
        <ol className="mt-2 list-inside list-decimal space-y-1.5">
          {guide.steps.map((step) => (
            <li key={step.id} className="leading-relaxed">
              {locale === "ar" ? step.ar : step.en}
              {step.url && (
                <a href={step.url} target="_blank" rel="noreferrer" className="ms-1 inline-flex items-center text-primary">
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </li>
          ))}
        </ol>
      </details>
      <Field label={s.name}>
        <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required maxLength={120} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={s.developerId}>
          <Input value={form.developerId} onChange={(e) => setForm({ ...form, developerId: e.target.value })} required pattern="\d{5,25}" dir="ltr" className="ltr font-mono" inputMode="numeric" />
        </Field>
        {type === "personal" && (
          <Field label={s.createdOn} hint={s.createdHint}>
            <Input type="date" value={form.accountCreatedOn} onChange={(e) => setForm({ ...form, accountCreatedOn: e.target.value })} required dir="ltr" />
          </Field>
        )}
      </div>
      <Field label={s.key}>
        <Input
          type="file"
          accept=".json,application/json"
          required
          className="py-2"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            const text = file && file.size < 10_000 ? await file.text() : "";
            const ok = text.includes('"service_account"') && text.includes("PRIVATE KEY");
            setError(file && !ok ? s["err.google_key_invalid"] : null);
            setForm((f) => ({ ...f, serviceAccountJson: ok ? text : "" }));
          }}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>{s.back}</Button>
        <Button type="submit" loading={busy} disabled={!form.serviceAccountJson}>{s.connect}</Button>
      </div>
    </form>
  );
}

/** After an Android release that Google forces onto the closed track (personal accounts since Nov 2023). */
export function ClosedTestNotice({ account }: { account: GoogleAccount | null }) {
  const s = useStrings(S);
  const p = closedTestProgress(account?.closedTestStartedAt ? new Date(account.closedTestStartedAt) : new Date());
  return (
    <Alert tone="warning" className="mb-4 space-y-2">
      <p className="flex items-center gap-2 font-medium">
        <Users className="size-4" />
        {s.ctTitle}
      </p>
      <p>{fill(s.ctBody, { testers: CLOSED_TEST_TESTERS, days: CLOSED_TEST_DAYS })}</p>
      <div className="h-2 overflow-hidden rounded-full bg-background/60" role="progressbar" aria-valuemin={0} aria-valuemax={CLOSED_TEST_DAYS} aria-valuenow={p.daysDone}>
        <div className="h-full bg-primary" style={{ width: `${(p.daysDone / CLOSED_TEST_DAYS) * 100}%` }} />
      </div>
      <p className="text-xs">{p.canApply ? s.ctReady : fill(s.ctProgress, { done: p.daysDone, days: CLOSED_TEST_DAYS })}</p>
      <a href="https://support.google.com/googleplay/android-developer/answer/9845334" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline">
        {s.ctHow} <ExternalLink className="size-3" />
      </a>
    </Alert>
  );
}
