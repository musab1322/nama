"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Building2, HeartHandshake } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, Badge, Button, Card, Field, Input, Segmented } from "@/components/ui/index";
import { AccountDeletion } from "@/app/settings/AccountDeletion";
import { ApiError } from "@/lib/api-client";
import { useStrings } from "@/i18n/strings";

export interface OrganizationView {
  id: string;
  kind: "business" | "charity";
  legal_name: string;
  license_number: string | null;
  verification_status: "unverified" | "pending" | "verified" | "rejected";
  donations_eligible: boolean;
  review_note: string | null;
  reviewed_at: string | null;
}

const S = {
  ar: {
    title: "الإعدادات",
    account: "الحساب",
    org: "الجهة",
    orgIntro: "اكتب اسم جهتك النظامي ليظهر في إشعار الخصوصية لتطبيقاتك. إن كانت جمعية أهلية مرخّصة فأرفق الترخيص لنوثّقها: تحصل على سعر الجمعيات، ويمكن السماح بالتبرعات داخل تطبيقاتها.",
    business: "منشأة أو فرد",
    charity: "جمعية أهلية",
    kind: "نوع الجهة",
    legalName: "الاسم النظامي",
    license: "رقم الترخيص (المركز الوطني لتنمية القطاع غير الربحي)",
    document: "صورة الترخيص (PDF أو صورة، حتى 5MB)",
    documentKeep: "اتركه فارغاً للإبقاء على المستند السابق.",
    save: "حفظ",
    saved: "حُفظ.",
    resubmitNote: "تغيير بيانات جمعية موثّقة يعيدها للمراجعة.",
    "st.unverified": "غير موثّقة",
    "st.pending": "قيد المراجعة",
    "st.verified": "موثّقة",
    "st.rejected": "لم تُقبل",
    pendingNote: "نراجع ترخيصك عادة خلال يومي عمل.",
    verifiedNote: "جمعيتك موثّقة. سعر الجمعيات يُطبق من دفعتك أو تجديدك التالي.",
    donations: "التبرعات داخل التطبيقات مسموحة",
    rejectedNote: "سبب عدم القبول:",
    "err.license_required": "الجمعية تحتاج رقم الترخيص.",
    "err.document_required": "الجمعية تحتاج صورة الترخيص.",
    "err.document_too_large": "المستند أكبر من 5MB.",
    "err.document_type": "ارفع PDF أو PNG أو JPEG.",
    error: "حدث خطأ. حاول مرة أخرى.",
  },
  en: {
    title: "Settings",
    account: "Account",
    org: "Organization",
    orgIntro: "Enter your legal name so it appears in your apps' privacy notice. If you are a licensed charity, attach the licence for verification: you get the charity price, and donations inside your apps can be allowed.",
    business: "Business or individual",
    charity: "Charity",
    kind: "Type",
    legalName: "Legal name",
    license: "Licence number (National Center for the Non-Profit Sector)",
    document: "Licence document (PDF or image, up to 5 MB)",
    documentKeep: "Leave empty to keep the previous document.",
    save: "Save",
    saved: "Saved.",
    resubmitNote: "Changing a verified charity's details sends it back for review.",
    "st.unverified": "Not verified",
    "st.pending": "Under review",
    "st.verified": "Verified",
    "st.rejected": "Not accepted",
    pendingNote: "We usually review licences within two business days.",
    verifiedNote: "Your charity is verified. The charity price applies from your next payment or renewal.",
    donations: "Donations inside apps are allowed",
    rejectedNote: "Reason:",
    "err.license_required": "A charity needs its licence number.",
    "err.document_required": "A charity needs its licence document.",
    "err.document_too_large": "The document is larger than 5 MB.",
    "err.document_type": "Upload a PDF, PNG or JPEG.",
    error: "Something went wrong. Try again.",
  },
};

const TONE = { unverified: "neutral", pending: "warning", verified: "success", rejected: "danger" } as const;

export function SettingsView({ credits, email, organization }: { credits: number; email: string; organization: OrganizationView | null }) {
  const s = useStrings(S);
  const router = useRouter();
  const [kind, setKind] = useState<"business" | "charity">(organization?.kind ?? "business");
  const [legalName, setLegalName] = useState(organization?.legal_name ?? "");
  const [license, setLicense] = useState(organization?.license_number ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.set("kind", kind);
    form.set("legalName", legalName);
    if (kind === "charity") form.set("licenseNumber", license);
    if (file) form.set("document", file);
    try {
      const res = await fetch("/api/organizations", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
      if (!res.ok) throw new ApiError(res.status, data.error?.code ?? "http_error", data.error?.message ?? res.statusText);
      setMessage({ tone: "success", text: s.saved });
      setFile(null);
      router.refresh();
    } catch (err) {
      const key = err instanceof ApiError ? (`err.${err.code}` as keyof typeof s) : null;
      setMessage({ tone: "danger", text: key && key in s ? s[key] : err instanceof ApiError ? err.message : s.error });
    } finally {
      setBusy(false);
    }
  }

  const status = organization?.verification_status;
  return (
    <div className="min-h-dvh">
      <AppHeader credits={credits} />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-semibold">{s.title}</h1>

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 font-semibold">
              {kind === "charity" ? <HeartHandshake className="size-5 text-primary" /> : <Building2 className="size-5 text-primary" />}
              {s.org}
            </h2>
            {organization?.kind === "charity" && status && <Badge tone={TONE[status]}>{s[`st.${status}`]}</Badge>}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{s.orgIntro}</p>

          {organization?.kind === "charity" && status === "pending" && <Alert tone="info">{s.pendingNote}</Alert>}
          {organization?.kind === "charity" && status === "verified" && (
            <Alert tone="success" className="space-y-1">
              <p className="flex items-center gap-2"><BadgeCheck className="size-4" />{s.verifiedNote}</p>
              {organization.donations_eligible && <p>{s.donations}</p>}
            </Alert>
          )}
          {status === "rejected" && organization?.review_note && (
            <Alert tone="danger">
              {s.rejectedNote} {organization.review_note}
            </Alert>
          )}

          <form onSubmit={save} className="space-y-4">
            <Segmented
              label={s.kind}
              value={kind}
              onChange={setKind}
              options={[
                { value: "business", label: s.business },
                { value: "charity", label: s.charity },
              ]}
            />
            <Field label={s.legalName}>
              <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} required minLength={2} maxLength={200} />
            </Field>
            {kind === "charity" && (
              <>
                <Field label={s.license}>
                  <Input value={license} onChange={(e) => setLicense(e.target.value)} required maxLength={60} dir="ltr" className="ltr" />
                </Field>
                <Field label={s.document} hint={organization?.kind === "charity" ? s.documentKeep : undefined}>
                  <Input
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    required={organization?.kind !== "charity"}
                    className="py-2"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </Field>
                {status === "verified" && <p className="text-xs text-muted-foreground">{s.resubmitNote}</p>}
              </>
            )}
            {message && <Alert tone={message.tone}>{message.text}</Alert>}
            <div className="flex justify-end">
              <Button type="submit" loading={busy}>{s.save}</Button>
            </div>
          </form>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">{s.account}</h2>
          <p className="ltr text-sm text-muted-foreground">{email}</p>
          <AccountDeletion />
        </Card>
      </main>
    </div>
  );
}
