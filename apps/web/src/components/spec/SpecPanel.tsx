"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, ShieldAlert, Sparkles } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Textarea, cn } from "@/components/ui/index";
import { useProjectRows } from "@/hooks/useProjectRows";
import { api, ApiError } from "@/lib/api-client";
import { useLocale } from "@/i18n/client";
import { fill, useStrings } from "@/i18n/strings";
import { CREDIT_HOLD } from "@banna/shared/credit-rules";

export interface SpecRow {
  id: string;
  spec_number: number;
  status: "draft" | "approved" | "superseded";
  prompt: string | null;
  markdown: string | null;
  created_at: string;
  approved_at: string | null;
}

interface Finding {
  code: string;
  severity: "blocking" | "warning";
  platforms: string[];
  ar: string;
  en: string;
  ref?: string;
}

interface Review {
  issues: { path: string; code: string; message: string }[];
  findings: Finding[];
  approvable: boolean;
}

const CATEGORIES = ["store", "restaurant", "booking", "directory", "content", "charity"] as const;
const DRAFT_COST = CREDIT_HOLD.specDraft;

const S = {
  ar: {
    introTitle: "صف تطبيقك",
    intro: "اكتب فكرتك بلغتك. سنكتب لك أولاً مواصفات التطبيق: الشاشات والبيانات والصلاحيات والدفع. تراجعها وتعتمدها، ثم نبني التطبيق منها.",
    prompt: "ما التطبيق الذي تريده؟",
    placeholder: "مثال: متجر لبيع العسل في الرياض، فيه قائمة منتجات وسلة وطلب وتوصيل، ولوحة لي لمتابعة الطلبات.",
    category: "نوع التطبيق",
    "cat.store": "متجر",
    "cat.restaurant": "مطعم",
    "cat.booking": "حجوزات",
    "cat.directory": "دليل",
    "cat.content": "محتوى",
    "cat.charity": "جمعية",
    write: "اكتب المواصفات",
    cost: "حتى {n} رصيد",
    drafting: "نكتب المواصفات الآن… يستغرق ذلك عادة أقل من دقيقة.",
    slow: "ما زلنا نكتب. إن لم تظهر خلال دقائق فسيُعاد رصيدك تلقائياً، وحاول مرة أخرى.",
    specTitle: "المواصفات رقم {n}",
    draft: "مسودة للمراجعة",
    approved: "معتمدة",
    issues: "أمور تحتاج تصحيحاً قبل الاعتماد",
    findings: "ملاحظات سياسات المتاجر",
    blocking: "تمنع النشر",
    warning: "تنبيه",
    change: "تريد تعديلاً؟ اكتبه وسنعيد كتابة المواصفات",
    changePlaceholder: "مثال: أضف خيار الاستلام من المتجر، واحذف شاشة المدونة.",
    rewrite: "أعد الكتابة",
    approve: "اعتمد وابدأ البناء",
    approveCost: "البناء يكلّف حتى {n} رصيد، وتدفع ما يُستهلك فعلاً فقط. لن يتغير شيء في التطبيق قبل اعتمادك.",
    building: "اعتُمدت المواصفات. نبني التطبيق الآن، وستظهر المعاينة هنا عند الانتهاء.",
    notApprovable: "صحّح الأمور أعلاه أو اطلب تعديلاً، ثم اعتمد.",
    "err.insufficient_credits": "رصيدك لا يكفي. اشترِ رصيداً من صفحة الباقات.",
    "err.draft_in_progress": "نكتب مواصفات لهذا التطبيق الآن. انتظر حتى تنتهي.",
    "err.generation_in_progress": "يُبنى التطبيق الآن. انتظر حتى ينتهي.",
    "err.spec_locked": "هذه المواصفات معتمدة ولا تتغير. اطلب تعديلاً لكتابة نسخة جديدة.",
    error: "حدث خطأ. حاول مرة أخرى.",
  },
  en: {
    introTitle: "Describe your app",
    intro: "Write your idea in your own words. We first write the app's spec: screens, data, permissions and payments. You review and approve it, then we build the app from it.",
    prompt: "What app do you want?",
    placeholder: "Example: a honey shop in Riyadh with a product list, cart, ordering and delivery, and a dashboard for me to follow orders.",
    category: "App type",
    "cat.store": "Store",
    "cat.restaurant": "Restaurant",
    "cat.booking": "Bookings",
    "cat.directory": "Directory",
    "cat.content": "Content",
    "cat.charity": "Charity",
    write: "Write the spec",
    cost: "Up to {n} credits",
    drafting: "Writing the spec now… this usually takes under a minute.",
    slow: "Still writing. If it doesn't appear within a few minutes your credit is refunded automatically; then try again.",
    specTitle: "Spec #{n}",
    draft: "Draft for review",
    approved: "Approved",
    issues: "To fix before approval",
    findings: "App store policy notes",
    blocking: "Blocks publishing",
    warning: "Warning",
    change: "Want a change? Describe it and we'll rewrite the spec",
    changePlaceholder: "Example: add store pickup, and remove the blog screen.",
    rewrite: "Rewrite",
    approve: "Approve and build",
    approveCost: "Building costs up to {n} credits; you pay only what it actually uses. Nothing in the app changes before you approve.",
    building: "Spec approved. We're building the app now; the preview appears here when it's done.",
    notApprovable: "Fix the items above or ask for a change, then approve.",
    "err.insufficient_credits": "Not enough credits. Buy credits on the plans page.",
    "err.draft_in_progress": "A spec is being written for this app. Wait for it to finish.",
    "err.generation_in_progress": "The app is being built. Wait for it to finish.",
    "err.spec_locked": "This spec is approved and can't change. Ask for a change to write a new one.",
    error: "Something went wrong. Try again.",
  },
};

function errorText(s: (typeof S)["ar"], err: unknown) {
  if (err instanceof ApiError) {
    const key = `err.${err.code}` as keyof typeof s;
    return key in s ? s[key] : err.message;
  }
  return s.error;
}

/** Minimal, safe Markdown view for the spec (headings, bullets, bold); no HTML is injected. */
function SpecMarkdown({ text }: { text: string }) {
  const bold = (line: string) =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    );
  return (
    <div className="space-y-1.5 text-sm leading-relaxed">
      {text.split("\n").map((line, i) => {
        if (/^#{1,2}\s/.test(line)) return <h3 key={i} className="pt-3 text-base font-semibold">{line.replace(/^#+\s/, "")}</h3>;
        if (/^#{3,}\s/.test(line)) return <h4 key={i} className="pt-2 font-medium">{line.replace(/^#+\s/, "")}</h4>;
        if (/^\s*[-*]\s/.test(line)) {
          const depth = line.search(/\S/);
          return (
            <p key={i} className="flex gap-2" style={{ paddingInlineStart: `${depth * 6}px` }}>
              <span className="text-muted-foreground">•</span>
              <span>{bold(line.replace(/^\s*[-*]\s/, ""))}</span>
            </p>
          );
        }
        if (!line.trim()) return null;
        return <p key={i}>{bold(line)}</p>;
      })}
    </div>
  );
}

/**
 * The spec step (FR-002a/b, design §5.1): describe → draft → review → approve.
 * Used for a new app (instead of the chat) and for a substantive change to an existing app.
 */
export function SpecPanel({
  projectId,
  generating,
  onApproved,
  compact,
  buildCost = CREDIT_HOLD.newApp,
}: {
  projectId: string;
  generating: boolean;
  onApproved?: () => void;
  compact?: boolean;
  /** Most the build can charge: CREDIT_HOLD.newApp for the first build, .edit for a change (CR-004). */
  buildCost?: number;
}) {
  const s = useStrings(S);
  const locale = useLocale();
  const specs = useProjectRows<SpecRow>("app_specs", projectId, {
    select: "id, spec_number, status, prompt, markdown, created_at, approved_at",
    limit: 5,
  });
  const draft = useMemo(() => specs.rows.find((r) => r.status === "draft") ?? null, [specs.rows]);
  const approved = useMemo(() => specs.rows.find((r) => r.status === "approved") ?? null, [specs.rows]);

  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number] | "">("");
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState<"write" | "rewrite" | "approve" | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [slow, setSlow] = useState(false);

  // a new draft row ends the wait
  const latestId = specs.rows[0]?.id;
  useEffect(() => {
    setWaitingSince(null);
    setSlow(false);
  }, [latestId]);
  useEffect(() => {
    if (!waitingSince) return;
    const timer = setTimeout(() => setSlow(true), 120_000);
    return () => clearTimeout(timer);
  }, [waitingSince]);

  const loadReview = useCallback(async (id: string) => {
    try {
      setReview(await api<Review>(`/api/specs/${id}`));
    } catch {
      setReview(null);
    }
  }, []);
  useEffect(() => {
    if (draft) void loadReview(draft.id);
    else setReview(null);
  }, [draft, loadReview]);

  async function write(e: React.FormEvent) {
    e.preventDefault();
    setBusy("write");
    setError(null);
    try {
      await api("/api/specs", { body: { projectId, prompt, ...(category ? { category } : {}) } });
      setWaitingSince(Date.now());
    } catch (err) {
      setError(errorText(s, err));
    } finally {
      setBusy(null);
    }
  }

  async function rewrite() {
    if (!draft) return;
    setBusy("rewrite");
    setError(null);
    try {
      await api("/api/specs", { body: { projectId, prompt: change, baseSpecId: draft.id } });
      setChange("");
      setWaitingSince(Date.now());
    } catch (err) {
      setError(errorText(s, err));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!draft) return;
    setBusy("approve");
    setError(null);
    try {
      await api(`/api/specs/${draft.id}/approve`, { body: {} });
      await specs.reload();
      onApproved?.();
    } catch (err) {
      setError(errorText(s, err));
    } finally {
      setBusy(null);
    }
  }

  if (specs.loading) {
    return (
      <div className="grid flex-1 place-items-center p-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const waiting = waitingSince !== null;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto", compact ? "" : "p-4")}>
      {error && <Alert tone="danger">{error}</Alert>}

      {waiting && (
        <Alert tone="info" className="flex items-start gap-2">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
          <span>{slow ? s.slow : s.drafting}</span>
        </Alert>
      )}

      {!draft && !approved && !waiting && (
        <form onSubmit={write} className="space-y-4">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Sparkles className="size-5 text-primary" />
              {s.introTitle}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.intro}</p>
          </div>
          <Field label={s.prompt}>
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={s.placeholder} required minLength={3} maxLength={20000} className="min-h-32" />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{s.category}</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => setCategory(category === c ? "" : c)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm transition",
                    category === c ? "border-primary bg-accent text-primary" : "border-border hover:bg-muted",
                  )}
                >
                  {s[`cat.${c}`]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{fill(s.cost, { n: DRAFT_COST })}</span>
            <Button type="submit" loading={busy === "write"} disabled={prompt.trim().length < 3}>
              <FileText className="size-4" />
              {s.write}
            </Button>
          </div>
        </form>
      )}

      {draft && (
        <>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="font-semibold">{fill(s.specTitle, { n: draft.spec_number })}</h2>
              <Badge tone="warning">{s.draft}</Badge>
            </div>
            <SpecMarkdown text={draft.markdown ?? ""} />
          </Card>

          {review && review.issues.length > 0 && (
            <Card className="space-y-2 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <AlertTriangle className="size-4 text-warning" />
                {s.issues}
              </h3>
              <ul className="list-inside list-disc space-y-1 text-sm">
                {review.issues.map((i) => (
                  <li key={`${i.path}:${i.code}`}>{i.message}</li>
                ))}
              </ul>
            </Card>
          )}

          {review && review.findings.length > 0 && (
            <Card className="space-y-2 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <ShieldAlert className="size-4 text-primary" />
                {s.findings}
              </h3>
              <ul className="space-y-2 text-sm">
                {review.findings.map((f) => (
                  <li key={f.code} className="flex items-start gap-2">
                    <Badge tone={f.severity === "blocking" ? "danger" : "warning"} className="shrink-0">
                      {f.severity === "blocking" ? s.blocking : s.warning}
                    </Badge>
                    <span className="leading-relaxed">
                      {locale === "ar" ? f.ar : f.en}
                      {f.ref && (
                        <a href={f.ref} target="_blank" rel="noreferrer" className="ms-1 text-xs text-primary underline">
                          ↗
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="space-y-2">
            <Field label={s.change}>
              <Textarea value={change} onChange={(e) => setChange(e.target.value)} placeholder={s.changePlaceholder} maxLength={20000} />
            </Field>
            <div className="flex justify-end">
              <Button variant="outline" onClick={rewrite} loading={busy === "rewrite"} disabled={change.trim().length < 3 || waiting}>
                {s.rewrite} · {fill(s.cost, { n: DRAFT_COST })}
              </Button>
            </div>
          </div>

          <Card className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">{fill(s.approveCost, { n: buildCost })}</p>
            {review && !review.approvable && <Alert tone="warning">{s.notApprovable}</Alert>}
            <Button onClick={approve} loading={busy === "approve"} disabled={!review?.approvable || waiting || generating} className="w-full">
              <CheckCircle2 className="size-4" />
              {s.approve}
            </Button>
          </Card>
        </>
      )}

      {!draft && approved && (generating || !compact) && (
        <Alert tone="success" className="flex items-start gap-2">
          {generating ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
          <span>{s.building}</span>
        </Alert>
      )}
    </div>
  );
}
