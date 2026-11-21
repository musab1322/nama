"use client";

import { useCallback, useEffect, useState } from "react";
import { CreditCard, Download, MapPin } from "lucide-react";
import Link from "next/link";
import { Alert, Badge, Button, Dialog, Field, Input, Segmented, Spinner } from "@/components/ui/index";
import { MoyasarForm, type MoyasarConfig } from "@/components/billing/MoyasarForm";
import type { WorkspaceProject } from "@/components/workspace/Workspace";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiError } from "@/lib/api-client";
import { fill, useSar, useStrings } from "@/i18n/strings";

type Tab = "payments" | "hosting" | "export";

const S = {
  ar: {
    title: "إعدادات التطبيق",
    payments: "المدفوعات",
    hosting: "الاستضافة",
    export: "تصدير الكود",
    payIntro: "عملاء تطبيقك يدفعون لك مباشرة عبر حسابك في Moyasar. المنصة لا تأخذ شيئاً من مبيعاتك، ولا تحتفظ بمفتاحك السري.",
    payConnected: "متصل بـ Moyasar",
    payLive: "حقيقي",
    payTest: "تجريبي",
    payPending: "سيُفعَّل المفتاح عند تجهيز قاعدة بيانات التطبيق",
    pk: "المفتاح العام (pk_…)",
    sk: "المفتاح السري (sk_…)",
    skHint: "يُرسَل إلى قاعدة بيانات تطبيقك فقط، ولا يُعرض مرة أخرى.",
    connect: "ربط الحساب",
    replace: "استبدال المفاتيح",
    "err.moyasar_key_rejected": "رفضت Moyasar المفتاح السري. انسخه من لوحة Moyasar مرة أخرى.",
    hostIntro: "افتراضياً تُحفظ بيانات مستخدمي تطبيقك لدى مزوّد سحابي خارج المملكة، بضمانات تعاقدية. إن احتجت بقاءها داخل السعودية (مثل بعض الجمعيات والجهات) فاطلب الاستضافة داخل المملكة كإضافة مدفوعة.",
    hostRequest: "اطلب الاستضافة داخل المملكة",
    hostRequested: "استلمنا طلبك. سنرسل لك عرض السعر هنا (رسوم تجهيز + رسوم شهرية).",
    hostQuoted: "عرض السعر",
    setup: "رسوم التجهيز",
    monthly: "شهرياً (تضاف إلى تجديد باقتك)",
    payNow: "ادفع رسوم التجهيز",
    cancel: "إلغاء الطلب",
    hostPaid: "تم الدفع. نجهّز الاستضافة داخل المملكة، وسننقل بيانات تطبيقك إليها دون فقد. سنخبرك قبل أي توقف قصير.",
    hostActive: "بيانات تطبيقك تُحفظ داخل المملكة العربية السعودية.",
    "err.plan_required": "هذه الخدمة تحتاج باقة مدفوعة.",
    exportIntro: "نزّل الكود الكامل لتطبيقك مع قاعدة البيانات ودليل التشغيل. لا يحتوي على أي مفتاح سري ولا على بيانات مستخدميك.",
    exportStart: "جهّز ملف التصدير",
    exportRunning: "نجهّز الملف…",
    exportReady: "الملف جاهز",
    download: "تنزيل",
    expires: "الرابط صالح 24 ساعة.",
    exportPlan: "تصدير الكود متاح في الباقة الاحترافية.",
    plans: "الباقات",
    error: "حدث خطأ. حاول مرة أخرى.",
  },
  en: {
    title: "App settings",
    payments: "Payments",
    hosting: "Hosting",
    export: "Code export",
    payIntro: "Your app's customers pay you directly through your own Moyasar account. The platform takes nothing from your sales and does not keep your secret key.",
    payConnected: "Connected to Moyasar",
    payLive: "Live",
    payTest: "Test",
    payPending: "The key becomes active when the app's database is set up",
    pk: "Publishable key (pk_…)",
    sk: "Secret key (sk_…)",
    skHint: "Sent only to your app's own database, and never shown again.",
    connect: "Connect",
    replace: "Replace keys",
    "err.moyasar_key_rejected": "Moyasar rejected the secret key. Copy it from the Moyasar dashboard again.",
    hostIntro: "By default your app's user data is stored with a cloud provider outside Saudi Arabia under contractual safeguards. If it must stay inside the Kingdom (as for some charities and agencies), request in-Kingdom hosting as a paid add-on.",
    hostRequest: "Request in-Kingdom hosting",
    hostRequested: "We received your request. We'll send the quote here (setup fee + monthly fee).",
    hostQuoted: "Quote",
    setup: "Setup fee",
    monthly: "Monthly (added to your plan renewal)",
    payNow: "Pay the setup fee",
    cancel: "Cancel request",
    hostPaid: "Paid. We're preparing in-Kingdom hosting and will move your app's data there without loss. We'll tell you before any short pause.",
    hostActive: "Your app's data is stored inside Saudi Arabia.",
    "err.plan_required": "This needs a paid plan.",
    exportIntro: "Download your app's full source with its database schema and a how-to-run guide. It contains no secret keys and none of your users' data.",
    exportStart: "Prepare the export",
    exportRunning: "Preparing the file…",
    exportReady: "The file is ready",
    download: "Download",
    expires: "The link works for 24 hours.",
    exportPlan: "Code export is part of the Pro plan.",
    plans: "Plans",
    error: "Something went wrong. Try again.",
  },
};

type Strings = (typeof S)["ar"];
const errText = (s: Strings, err: unknown) => {
  if (err instanceof ApiError) {
    const key = `err.${err.code}` as keyof Strings;
    return key in s ? s[key] : err.message;
  }
  return s.error;
};

export function ProjectSettingsDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: WorkspaceProject }) {
  const s = useStrings(S);
  const [tab, setTab] = useState<Tab>("payments");
  return (
    <Dialog open={open} onClose={onClose} title={s.title} wide>
      <div className="space-y-5">
        <Segmented
          label={s.title}
          value={tab}
          onChange={setTab}
          options={[
            { value: "payments", label: s.payments, icon: <CreditCard className="size-4" /> },
            { value: "hosting", label: s.hosting, icon: <MapPin className="size-4" /> },
            { value: "export", label: s.export, icon: <Download className="size-4" /> },
          ]}
        />
        {tab === "payments" && <PaymentsTab s={s} projectId={project.id} />}
        {tab === "hosting" && <HostingTab s={s} projectId={project.id} />}
        {tab === "export" && <ExportTab s={s} project={project} />}
      </div>
    </Dialog>
  );
}

function PaymentsTab({ s, projectId }: { s: Strings; projectId: string }) {
  const [account, setAccount] = useState<{ publishable_key: string; status: string; key_mode: string | null } | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ publishableKey: "", secretKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await browserClient()
      .from("app_payment_accounts")
      .select("publishable_key, status, key_mode")
      .eq("project_id", projectId)
      .maybeSingle();
    setAccount((data as typeof account) ?? null);
  }, [projectId]);
  useEffect(() => void load(), [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/payment-accounts/moyasar", { body: { projectId, publishableKey: form.publishableKey.trim(), secretKey: form.secretKey.trim() } });
      setForm({ publishableKey: "", secretKey: "" });
      setEditing(false);
      await load();
    } catch (err) {
      setError(errText(s, err));
    } finally {
      setBusy(false);
    }
  }

  if (account === undefined) return <Spinner />;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{s.payIntro}</p>
      {account && !editing && (
        <div className="space-y-3">
          <Alert tone={account.status === "active" ? "success" : "info"} className="flex flex-wrap items-center gap-2">
            {s.payConnected}
            <Badge tone={account.key_mode === "live" ? "success" : "warning"}>{account.key_mode === "live" ? s.payLive : s.payTest}</Badge>
            <span className="ltr font-mono text-xs">{account.publishable_key.slice(0, 16)}…</span>
          </Alert>
          {account.status === "pending" && <p className="text-xs text-muted-foreground">{s.payPending}</p>}
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{s.replace}</Button>
        </div>
      )}
      {(!account || editing) && (
        <form onSubmit={save} className="space-y-3">
          <Field label={s.pk}>
            <Input value={form.publishableKey} onChange={(e) => setForm({ ...form, publishableKey: e.target.value })} required pattern="pk_(live|test)_[A-Za-z0-9]+" dir="ltr" className="ltr font-mono" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label={s.sk} hint={s.skHint}>
            <Input type="password" value={form.secretKey} onChange={(e) => setForm({ ...form, secretKey: e.target.value })} required pattern="sk_(live|test)_[A-Za-z0-9]+" dir="ltr" className="ltr font-mono" spellCheck={false} autoComplete="off" />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>{s.connect}</Button>
          </div>
        </form>
      )}
    </div>
  );
}

interface HostingRequest {
  id: string;
  status: string;
  setup_fee_halalas: number | null;
  monthly_fee_halalas: number | null;
  note: string | null;
}

function HostingTab({ s, projectId }: { s: Strings; projectId: string }) {
  const sar = useSar();
  const [requests, setRequests] = useState<HostingRequest[] | null>(null);
  const [checkout, setCheckout] = useState<MoyasarConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ requests: HostingRequest[] }>(`/api/hosting-requests?projectId=${projectId}`);
      setRequests(res.requests);
    } catch {
      setRequests([]);
    }
  }, [projectId]);
  useEffect(() => void load(), [load]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errText(s, err));
    } finally {
      setBusy(null);
    }
  };

  if (!requests) return <Spinner />;
  const open = requests.find((r) => r.status !== "canceled");

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{s.hostIntro}</p>
      {error && (
        <Alert tone="danger">
          {error}{" "}
          {error === s["err.plan_required"] && <Link href="/billing" className="underline">{s.plans}</Link>}
        </Alert>
      )}
      {!open && (
        <Button onClick={() => run("request", async () => { await api("/api/hosting-requests", { body: { projectId } }); await load(); })} loading={busy === "request"}>
          <MapPin className="size-4" />
          {s.hostRequest}
        </Button>
      )}
      {open?.status === "requested" && (
        <div className="space-y-3">
          <Alert tone="info">{s.hostRequested}</Alert>
          <Button variant="ghost" size="sm" onClick={() => run("cancel", async () => { await api(`/api/hosting-requests/${open.id}`, { method: "DELETE" }); await load(); })} loading={busy === "cancel"}>
            {s.cancel}
          </Button>
        </div>
      )}
      {open?.status === "quoted" && (
        <div className="space-y-3">
          <h3 className="font-semibold">{s.hostQuoted}</h3>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">{s.setup}</dt>
            <dd className="font-medium">{sar(open.setup_fee_halalas ?? 0)}</dd>
            <dt className="text-muted-foreground">{s.monthly}</dt>
            <dd className="font-medium">{sar(open.monthly_fee_halalas ?? 0)}</dd>
          </dl>
          {open.note && <Alert tone="neutral" className="whitespace-pre-line">{open.note}</Alert>}
          {checkout ? (
            <MoyasarForm config={checkout} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => run("pay", async () => {
                  const res = await api<{ form: MoyasarConfig }>(`/api/hosting-requests/${open.id}/checkout`, { body: {} });
                  setCheckout(res.form);
                })}
                loading={busy === "pay"}
              >
                {s.payNow}
              </Button>
              <Button variant="ghost" onClick={() => run("cancel", async () => { await api(`/api/hosting-requests/${open.id}`, { method: "DELETE" }); await load(); })} loading={busy === "cancel"}>
                {s.cancel}
              </Button>
            </div>
          )}
        </div>
      )}
      {open && ["paid", "provisioning", "migrating"].includes(open.status) && <Alert tone="info">{s.hostPaid}</Alert>}
      {open?.status === "active" && <Alert tone="success">{s.hostActive}</Alert>}
    </div>
  );
}

function ExportTab({ s, project }: { s: Strings; project: WorkspaceProject }) {
  const [job, setJob] = useState<{ id: string; status: string; url?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status === "ready" || job.status === "failed" || job.status === "expired") return;
    const timer = setInterval(async () => {
      try {
        const res = await api<{ export: { id: string; status: string; url: string | null } }>(`/api/exports/${job.id}`);
        setJob(res.export);
      } catch {
        // keep polling
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [job]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ export: { id: string; status: string } }>("/api/exports", { body: { projectId: project.id } });
      setJob(res.export);
    } catch (err) {
      setError(err instanceof ApiError && err.code === "plan_required" ? s.exportPlan : errText(s, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{s.exportIntro}</p>
      {error && (
        <Alert tone="warning">
          {error} {error === s.exportPlan && <Link href="/billing" className="underline">{s.plans}</Link>}
        </Alert>
      )}
      {!job && (
        <Button onClick={start} loading={busy} disabled={!project.current_version_id}>
          <Download className="size-4" />
          {s.exportStart}
        </Button>
      )}
      {job && job.status !== "ready" && job.status !== "failed" && (
        <Alert tone="info" className="flex items-center gap-2">
          <Spinner />
          {s.exportRunning}
        </Alert>
      )}
      {job?.status === "ready" && job.url && (
        <div className="space-y-2">
          <Alert tone="success">{s.exportReady}</Alert>
          <a href={job.url} className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground">
            <Download className="size-4" />
            {s.download}
          </a>
          <p className="text-xs text-muted-foreground">{s.expires}</p>
        </div>
      )}
      {job?.status === "failed" && <Alert tone="danger">{fill(s.error, {})}</Alert>}
    </div>
  );
}
