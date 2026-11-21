"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Building2, Flag, LayoutDashboard, MapPin, Search, ShieldOff, Users } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Alert, Badge, Button, Card, Field, Input, Spinner, Textarea, cn } from "@/components/ui/index";
import { api, ApiError } from "@/lib/api-client";
import { useLocale, useRelativeTime } from "@/i18n/client";
import { useSar, useStrings } from "@/i18n/strings";

type Tab = "overview" | "charities" | "hosting" | "reports" | "projects" | "users" | "jobs";

const S = {
  ar: {
    title: "لوحة الإدارة",
    overview: "نظرة عامة",
    charities: "توثيق الجمعيات",
    hosting: "الاستضافة السعودية",
    reports: "البلاغات",
    projects: "التطبيقات",
    users: "العملاء",
    jobs: "الطوابير",
    privacy: "لا تعرض هذه اللوحة أي بيانات لمستخدمي التطبيقات.",
    "o.users": "العملاء",
    "o.paid_subscriptions": "اشتراكات مدفوعة",
    "o.past_due": "متعثرون في الدفع",
    "o.projects": "تطبيقات",
    "o.suspended_projects": "تطبيقات موقوفة",
    "o.open_reports": "بلاغات مفتوحة",
    "o.pending_charities": "جمعيات بانتظار التوثيق",
    "o.hosting_to_quote": "طلبات استضافة للتسعير",
    "o.hosting_to_fulfil": "استضافة مدفوعة للتنفيذ",
    "o.revenue_30d_halalas": "الإيراد (30 يوماً)",
    "o.credits_spent_30d": "رصيد مستهلك (30 يوماً)",
    cell: "الخلية السعودية",
    cellOn: "مهيأة",
    cellOff: "غير مهيأة بعد",
    document: "المستند",
    license: "الترخيص",
    owner: "المالك",
    verify: "توثيق",
    reject: "رفض",
    revoke: "سحب التوثيق",
    allowDonations: "السماح بالتبرعات داخل تطبيقاتها",
    note: "ملاحظة للمالك (مطلوبة عند الرفض)",
    empty: "لا شيء هنا الآن.",
    setup: "رسوم التجهيز (ريال)",
    monthly: "شهرياً (ريال)",
    quoteNote: "ملاحظة للعميل (مثل مدة تجهيز الخلية)",
    sendQuote: "إرسال العرض",
    needsMigration: "يحتاج نقل بيانات من الاستضافة القياسية",
    newBackend: "تُنشأ الخلفية في الخلية عند النشر",
    status: "الحالة",
    markReviewing: "قيد المراجعة",
    markActioned: "اتُّخذ إجراء",
    dismiss: "رفض البلاغ",
    search: "بحث",
    suspend: "إيقاف",
    unsuspend: "رفع الإيقاف",
    reason: "السبب (يُحفظ في سجل التدقيق)",
    suspended: "موقوف",
    credits: "الرصيد",
    grant: "تعديل الرصيد",
    amount: "الكمية (سالبة للخصم)",
    stats: "إحصاءات",
    failed: "مهام فشلت",
    waiting: "مهام في الانتظار",
    attempts: "المحاولات",
    error: "حدث خطأ.",
    confirmSuspend: "تأكيد الإيقاف",
  },
  en: {
    title: "Admin",
    overview: "Overview",
    charities: "Charity verification",
    hosting: "Saudi hosting",
    reports: "Reports",
    projects: "Apps",
    users: "Customers",
    jobs: "Queues",
    privacy: "This panel never shows data of the apps' end users.",
    "o.users": "Customers",
    "o.paid_subscriptions": "Paid subscriptions",
    "o.past_due": "Past due",
    "o.projects": "Apps",
    "o.suspended_projects": "Suspended apps",
    "o.open_reports": "Open reports",
    "o.pending_charities": "Charities to verify",
    "o.hosting_to_quote": "Hosting requests to quote",
    "o.hosting_to_fulfil": "Paid hosting to fulfil",
    "o.revenue_30d_halalas": "Revenue (30 days)",
    "o.credits_spent_30d": "Credits spent (30 days)",
    cell: "Saudi cell",
    cellOn: "Configured",
    cellOff: "Not set up yet",
    document: "Document",
    license: "Licence",
    owner: "Owner",
    verify: "Verify",
    reject: "Reject",
    revoke: "Revoke",
    allowDonations: "Allow donations inside its apps",
    note: "Note to the owner (required to reject)",
    empty: "Nothing here right now.",
    setup: "Setup fee (SAR)",
    monthly: "Monthly (SAR)",
    quoteNote: "Note to the customer (e.g. cell setup time)",
    sendQuote: "Send quote",
    needsMigration: "Needs a data move from standard hosting",
    newBackend: "Backend is created in the cell at publish",
    status: "Status",
    markReviewing: "Reviewing",
    markActioned: "Actioned",
    dismiss: "Dismiss",
    search: "Search",
    suspend: "Suspend",
    unsuspend: "Lift suspension",
    reason: "Reason (kept in the audit log)",
    suspended: "Suspended",
    credits: "Credits",
    grant: "Adjust credits",
    amount: "Amount (negative to remove)",
    stats: "Stats",
    failed: "Failed jobs",
    waiting: "Waiting jobs",
    attempts: "Attempts",
    error: "Something went wrong.",
    confirmSuspend: "Confirm suspension",
  },
};
type Strings = (typeof S)["ar"];

function useAdminData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "error");
    }
  }, [path]);
  useEffect(() => void reload(), [reload]);
  return { data, error, reload };
}

async function act(fn: () => Promise<unknown>, setError: (e: string | null) => void, after: () => Promise<void> | void) {
  setError(null);
  try {
    await fn();
    await after();
  } catch (err) {
    setError(err instanceof ApiError ? err.message : "error");
  }
}

export function AdminView({ credits }: { credits: number }) {
  const s = useStrings(S);
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: { id: Tab; icon: React.ReactNode }[] = [
    { id: "overview", icon: <LayoutDashboard className="size-4" /> },
    { id: "charities", icon: <Building2 className="size-4" /> },
    { id: "hosting", icon: <MapPin className="size-4" /> },
    { id: "reports", icon: <Flag className="size-4" /> },
    { id: "projects", icon: <ShieldOff className="size-4" /> },
    { id: "users", icon: <Users className="size-4" /> },
    { id: "jobs", icon: <Activity className="size-4" /> },
  ];
  return (
    <div className="min-h-dvh">
      <AppHeader credits={credits} />
      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-6 max-md:flex-col">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-52 md:flex-col" aria-label={s.title}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-start text-sm",
                tab === t.id ? "bg-accent font-medium text-primary" : "hover:bg-muted",
              )}
            >
              {t.icon}
              {s[t.id]}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-xl font-semibold">{s[tab]}</h1>
            <p className="text-xs text-muted-foreground">{s.privacy}</p>
          </div>
          {tab === "overview" && <Overview s={s} />}
          {tab === "charities" && <Charities s={s} />}
          {tab === "hosting" && <Hosting s={s} />}
          {tab === "reports" && <Reports s={s} />}
          {tab === "projects" && <Projects s={s} />}
          {tab === "users" && <Customers s={s} />}
          {tab === "jobs" && <Jobs s={s} />}
        </main>
      </div>
    </div>
  );
}

function Overview({ s }: { s: Strings }) {
  const sar = useSar();
  const locale = useLocale();
  const { data } = useAdminData<{ overview: Record<string, unknown>; saudiCellConfigured: boolean }>("/api/admin/overview");
  if (!data) return <Spinner />;
  const keys = ["users", "paid_subscriptions", "past_due", "projects", "suspended_projects", "open_reports", "pending_charities", "hosting_to_quote", "hosting_to_fulfil", "revenue_30d_halalas", "credits_spent_30d"] as const;
  const backends = (data.overview.backends ?? {}) as Record<string, number>;
  const jobs = (data.overview.jobs ?? {}) as Record<string, number>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {keys.map((k) => (
          <Card key={k} className="p-4">
            <p className="text-xs text-muted-foreground">{s[`o.${k}`]}</p>
            <p className="mt-1 text-2xl font-semibold">
              {k === "revenue_30d_halalas" ? sar(Number(data.overview[k] ?? 0)) : Number(data.overview[k] ?? 0).toLocaleString(locale)}
            </p>
          </Card>
        ))}
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">{s.cell}</p>
          <p className="mt-1 font-semibold">{data.saudiCellConfigured ? s.cellOn : s.cellOff}</p>
        </Card>
      </div>
      <Card className="flex flex-wrap gap-2 p-4 text-sm">
        {Object.entries(backends).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1"><StatusBadge status={k} /> {v}</span>
        ))}
        <span className="mx-2 h-5 w-px bg-border" />
        {Object.entries(jobs).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1"><StatusBadge status={k} /> {v}</span>
        ))}
      </Card>
    </div>
  );
}

interface AdminOrg {
  id: string;
  kind: string;
  legal_name: string;
  license_number: string | null;
  verification_status: string;
  updated_at: string;
  documentUrl: string | null;
  profiles: { email: string | null; full_name: string | null } | null;
}

function Charities({ s }: { s: Strings }) {
  const [status, setStatus] = useState<"pending" | "verified" | "rejected">("pending");
  const { data, reload } = useAdminData<{ organizations: AdminOrg[] }>(`/api/admin/organizations?status=${status}`);
  return (
    <div className="space-y-3">
      <StatusFilter value={status} onChange={setStatus} options={["pending", "verified", "rejected"]} />
      {!data ? <Spinner /> : data.organizations.length === 0 ? <p className="text-sm text-muted-foreground">{s.empty}</p> : data.organizations.map((o) => <CharityCard key={o.id} s={s} org={o} onDone={reload} />)}
    </div>
  );
}

function CharityCard({ s, org, onDone }: { s: Strings; org: AdminOrg; onDone: () => Promise<void> }) {
  const [note, setNote] = useState("");
  const [donations, setDonations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = (decision: "verify" | "reject") =>
    act(() => api(`/api/admin/organizations/${org.id}/review`, { body: { decision, donationsEligible: donations, note: note || undefined } }), setError, onDone);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{org.legal_name}</h3>
        <StatusBadge status={org.verification_status} />
        <span className="ltr text-xs text-muted-foreground">{org.profiles?.email}</span>
      </div>
      <p className="text-sm">
        {s.license}: <span className="ltr font-mono">{org.license_number ?? "—"}</span>
        {org.documentUrl && (
          <a href={org.documentUrl} target="_blank" rel="noreferrer" className="ms-3 text-primary underline">{s.document}</a>
        )}
      </p>
      <Field label={s.note}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-16" />
      </Field>
      {org.verification_status === "pending" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={donations} onChange={(e) => setDonations(e.target.checked)} />
          {s.allowDonations}
        </label>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        {org.verification_status === "pending" && <Button size="sm" onClick={() => review("verify")}>{s.verify}</Button>}
        <Button size="sm" variant="outline" onClick={() => review("reject")} disabled={!note.trim()}>
          {org.verification_status === "verified" ? s.revoke : s.reject}
        </Button>
      </div>
    </Card>
  );
}

interface AdminHosting {
  id: string;
  status: string;
  setup_fee_halalas: number | null;
  monthly_fee_halalas: number | null;
  created_at: string;
  needsMigration: boolean;
  projects: { name: string; slug: string } | null;
}

function Hosting({ s }: { s: Strings }) {
  const [status, setStatus] = useState<"requested" | "quoted" | "paid" | "active">("requested");
  const { data, reload } = useAdminData<{ requests: AdminHosting[]; cellConfigured: boolean }>(`/api/admin/hosting-requests?status=${status}`);
  return (
    <div className="space-y-3">
      <StatusFilter value={status} onChange={setStatus} options={["requested", "quoted", "paid", "active"]} />
      {data && !data.cellConfigured && <Alert tone="warning">{s.cell}: {s.cellOff}</Alert>}
      {!data ? <Spinner /> : data.requests.length === 0 ? <p className="text-sm text-muted-foreground">{s.empty}</p> : data.requests.map((r) => <HostingCard key={r.id} s={s} req={r} onDone={reload} />)}
    </div>
  );
}

function HostingCard({ s, req, onDone }: { s: Strings; req: AdminHosting; onDone: () => Promise<void> }) {
  const sar = useSar();
  const [setup, setSetup] = useState(req.setup_fee_halalas ? String(req.setup_fee_halalas / 100) : "");
  const [monthly, setMonthly] = useState(req.monthly_fee_halalas !== null ? String(req.monthly_fee_halalas / 100) : "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{req.projects?.name}</h3>
        <span className="ltr text-xs text-muted-foreground">{req.projects?.slug}</span>
        <StatusBadge status={req.status} />
        {req.setup_fee_halalas !== null && <span className="text-xs">{sar(req.setup_fee_halalas)} + {sar(req.monthly_fee_halalas ?? 0)}</span>}
      </div>
      {["paid", "migrating"].includes(req.status) && <Alert tone={req.needsMigration ? "warning" : "info"}>{req.needsMigration ? s.needsMigration : s.newBackend}</Alert>}
      {["requested", "quoted"].includes(req.status) && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={s.setup}><Input type="number" min={1} step="0.01" value={setup} onChange={(e) => setSetup(e.target.value)} dir="ltr" /></Field>
            <Field label={s.monthly}><Input type="number" min={0} step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)} dir="ltr" /></Field>
          </div>
          <Field label={s.quoteNote}><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-16" /></Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button
            size="sm"
            disabled={!setup || monthly === ""}
            onClick={() => act(() => api(`/api/admin/hosting-requests/${req.id}/quote`, { body: { setupSar: Number(setup), monthlySar: Number(monthly), note: note || undefined } }), setError, onDone)}
          >
            {s.sendQuote}
          </Button>
        </>
      )}
    </Card>
  );
}

interface AdminReport {
  id: string;
  reason: string;
  details: string | null;
  reporter_email: string | null;
  status: string;
  created_at: string;
  projects: { id: string; name: string; slug: string; suspended_at: string | null } | null;
}

function Reports({ s }: { s: Strings }) {
  const ago = useRelativeTime();
  const [status, setStatus] = useState<"open" | "reviewing" | "actioned" | "dismissed">("open");
  const { data, reload } = useAdminData<{ reports: AdminReport[] }>(`/api/admin/reports?status=${status}`);
  const [error, setError] = useState<string | null>(null);
  const move = (id: string, next: "reviewing" | "actioned" | "dismissed") => act(() => api(`/api/admin/reports/${id}`, { method: "PATCH", body: { status: next } }), setError, reload);
  return (
    <div className="space-y-3">
      <StatusFilter value={status} onChange={setStatus} options={["open", "reviewing", "actioned", "dismissed"]} />
      {error && <Alert tone="danger">{error}</Alert>}
      {!data ? <Spinner /> : data.reports.length === 0 ? <p className="text-sm text-muted-foreground">{s.empty}</p> : data.reports.map((r) => (
        <Card key={r.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="danger">{r.reason}</Badge>
            <span className="font-medium">{r.projects?.name}</span>
            <span className="ltr text-xs text-muted-foreground">{r.projects?.slug}</span>
            {r.projects?.suspended_at && <Badge tone="warning">{s.suspended}</Badge>}
            <span className="ms-auto text-xs text-muted-foreground">{ago(r.created_at)}</span>
          </div>
          {r.details && <p className="whitespace-pre-line text-sm">{r.details}</p>}
          {r.reporter_email && <p className="ltr text-xs text-muted-foreground">{r.reporter_email}</p>}
          <div className="flex flex-wrap gap-2">
            {r.status === "open" && <Button size="sm" variant="outline" onClick={() => move(r.id, "reviewing")}>{s.markReviewing}</Button>}
            {["open", "reviewing"].includes(r.status) && (
              <>
                <Button size="sm" onClick={() => move(r.id, "actioned")}>{s.markActioned}</Button>
                <Button size="sm" variant="ghost" onClick={() => move(r.id, "dismissed")}>{s.dismiss}</Button>
              </>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

interface AdminProject {
  id: string;
  name: string;
  slug: string;
  status: string;
  suspended_at: string | null;
  suspension_reason: string | null;
  profiles: { email: string | null } | null;
  app_backends: { hosting: string; status: string } | { hosting: string; status: string }[] | null;
  reports: { count: number }[];
}

function Projects({ s }: { s: Strings }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, reload } = useAdminData<{ projects: AdminProject[] }>(`/api/admin/projects?q=${encodeURIComponent(query)}`);
  return (
    <div className="space-y-3">
      <SearchBox s={s} value={q} onChange={setQ} onSearch={() => setQuery(q)} />
      {!data ? <Spinner /> : data.projects.map((p) => <ProjectRow key={p.id} s={s} p={p} onDone={reload} />)}
    </div>
  );
}

function ProjectRow({ s, p, onDone }: { s: Strings; p: AdminProject; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backend = Array.isArray(p.app_backends) ? p.app_backends[0] : p.app_backends;
  const loadStats = async () => {
    try {
      const r = await api<{ backendStats: { dbSizeBytes: number; storageBytes: number; monthlyActiveUsers: number } | null; creditsUsed: number }>(`/api/admin/projects/${p.id}/stats`);
      const b = r.backendStats;
      setStats(b ? `DB ${(b.dbSizeBytes / 1e6).toFixed(1)} MB · Storage ${(b.storageBytes / 1e6).toFixed(1)} MB · MAU ${b.monthlyActiveUsers} · credits ${r.creditsUsed}` : `credits ${r.creditsUsed}`);
    } catch (err) {
      setStats(err instanceof ApiError ? err.message : s.error);
    }
  };
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{p.name}</span>
        <span className="ltr text-xs text-muted-foreground">{p.slug} · {p.profiles?.email}</span>
        <StatusBadge status={p.status} />
        {backend && <Badge>{backend.hosting} · {backend.status}</Badge>}
        {(p.reports[0]?.count ?? 0) > 0 && <Badge tone="danger"><Flag className="size-3" /> {p.reports[0]!.count}</Badge>}
        {p.suspended_at && <Badge tone="warning">{s.suspended}</Badge>}
        <div className="ms-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={loadStats}>{s.stats}</Button>
          {p.suspended_at ? (
            <Button size="sm" variant="outline" onClick={() => act(() => api(`/api/admin/projects/${p.id}/suspend`, { method: "DELETE" }), setError, onDone)}>{s.unsuspend}</Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>{s.suspend}</Button>
          )}
        </div>
      </div>
      {p.suspension_reason && <p className="text-xs text-muted-foreground">{p.suspension_reason}</p>}
      {stats && <p className="ltr text-xs text-muted-foreground">{stats}</p>}
      {open && !p.suspended_at && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-60 flex-1">
            <Field label={s.reason}><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
          </div>
          <Button size="sm" variant="danger" disabled={reason.trim().length < 3} onClick={() => act(() => api(`/api/admin/projects/${p.id}/suspend`, { body: { reason } }), setError, async () => { setOpen(false); await onDone(); })}>
            {s.confirmSuspend}
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

interface AdminUser {
  id: string;
  email: string | null;
  full_name: string | null;
  credits_balance: number;
  created_at: string;
  subscriptions: { status: string; plan: string }[];
  projects: { count: number }[];
}

function Customers({ s }: { s: Strings }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, reload } = useAdminData<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`);
  return (
    <div className="space-y-3">
      <SearchBox s={s} value={q} onChange={setQ} onSearch={() => setQuery(q)} />
      {!data ? <Spinner /> : data.users.map((u) => <UserRow key={u.id} s={s} u={u} onDone={reload} />)}
    </div>
  );
}

function UserRow({ s, u, onDone }: { s: Strings; u: AdminUser; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const live = u.subscriptions.find((x) => ["active", "trialing", "past_due"].includes(x.status));
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{u.full_name ?? "—"}</span>
        <span className="ltr text-xs text-muted-foreground">{u.email}</span>
        {live && <Badge tone={live.status === "past_due" ? "warning" : "success"}>{live.plan} · {live.status}</Badge>}
        <Badge>{s.credits}: {u.credits_balance}</Badge>
        <Badge>{s.projects}: {u.projects[0]?.count ?? 0}</Badge>
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setOpen(!open)}>{s.grant}</Button>
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32"><Field label={s.amount}><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} dir="ltr" /></Field></div>
          <div className="min-w-48 flex-1"><Field label={s.reason}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field></div>
          <Button size="sm" disabled={!amount || !note.trim()} onClick={() => act(() => api(`/api/admin/users/${u.id}/credits`, { body: { amount: Number(amount), note } }), setError, async () => { setOpen(false); await onDone(); })}>
            {s.grant}
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

interface JobRow {
  id: number;
  kind: string;
  status: string;
  attempts: number;
  max_attempts?: number;
  last_error?: string | null;
  updated_at?: string;
  created_at?: string;
}

function Jobs({ s }: { s: Strings }) {
  const ago = useRelativeTime();
  const { data } = useAdminData<{ failed: JobRow[]; waiting: JobRow[] }>("/api/admin/jobs");
  if (!data) return <Spinner />;
  const table = (rows: JobRow[], title: string) => (
    <Card className="overflow-x-auto p-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{s.empty}</p> : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((j) => (
              <tr key={j.id} className="border-t border-border align-top">
                <td className="ltr py-1.5 pe-3 font-mono text-xs">{j.kind}</td>
                <td className="py-1.5 pe-3"><Badge>{j.status}</Badge></td>
                <td className="py-1.5 pe-3 text-xs">{s.attempts}: {j.attempts}{j.max_attempts ? `/${j.max_attempts}` : ""}</td>
                <td className="py-1.5 pe-3 text-xs text-muted-foreground">{ago((j.updated_at ?? j.created_at)!)}</td>
                <td className="ltr max-w-md truncate py-1.5 text-xs text-danger" title={j.last_error ?? ""}>{j.last_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
  return (
    <div className="space-y-4">
      {table(data.failed, s.failed)}
      {table(data.waiting, s.waiting)}
    </div>
  );
}

function StatusFilter<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: T[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} aria-pressed={value === o} className={cn("rounded-full border px-3 py-1 text-xs", value === o ? "border-primary bg-accent text-primary" : "border-border hover:bg-muted")}>
          <StatusBadge status={o} />
        </button>
      ))}
    </div>
  );
}

function SearchBox({ s, value, onChange, onSearch }: { s: Strings; value: string; onChange: (v: string) => void; onSearch: () => void }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSearch(); }} className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={s.search} maxLength={80} />
      <Button type="submit" variant="outline"><Search className="size-4" />{s.search}</Button>
    </form>
  );
}
