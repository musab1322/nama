"use client";

import { useEffect, useMemo, useState } from "react";
import { Apple, Check, CheckCircle2, Circle, ExternalLink, ImageUp, KeyRound, Smartphone, XCircle } from "lucide-react";
import { Alert, Badge, Button, Dialog, Field, Input, Spinner, Textarea, cn } from "@/components/ui/index";
import { StatusBadge } from "@/components/StatusBadge";
import { useProjectRows } from "@/hooks/useProjectRows";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiError } from "@/lib/api-client";
import { useRelativeTime, useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/dict";
import type { WorkspaceProject } from "@/components/workspace/Workspace";
import { ClosedTestNotice, GoogleStep, loadGoogleAccount, type GoogleAccount } from "@/components/publish/GoogleStep";

type Platform = "ios" | "android";
type Step = "platforms" | "google" | "apple" | "listing" | "review" | "tracker";

interface Listing {
  displayName: string;
  subtitle: string;
  shortDescription: string;
  fullDescription: string;
  keywords: string;
  category: string;
  privacyPolicyUrl: string;
  iconPath: string | null;
}
interface Submission {
  id: string;
  platform: Platform;
  mobile_build_id: string;
  status: string;
  track: string;
  store_url: string | null;
  rejection_reason: string | null;
  status_history: { status: string; at: string; reason: string | null }[];
  created_at: string;
}
interface Build {
  id: string;
  platform: Platform;
  status: string;
  app_version: string;
  build_number: number;
  error_message: string | null;
}
interface MobileApp {
  id: string;
  platform: Platform;
  bundle_identifier: string;
  display_name: string;
  subtitle: string | null;
  short_description: string | null;
  full_description: string | null;
  keywords: string | null;
  category: string | null;
  privacy_policy_url: string | null;
  icon_path: string | null;
}

const CATEGORIES = ["shopping", "food", "business", "education", "health", "lifestyle", "productivity", "social", "travel", "utilities"] as const;
const ACTIVE = new Set(["queued", "awaiting_store_setup", "submitting", "submitted", "in_review"]);

export function StorePublishDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: WorkspaceProject }) {
  const t = useT();
  const submissions = useProjectRows<Submission>("store_submissions", project.id, {
    select: "id, platform, mobile_build_id, status, track, store_url, rejection_reason, status_history, created_at",
    limit: 10,
  });
  const builds = useProjectRows<Build>("mobile_builds", project.id, {
    select: "id, platform, status, app_version, build_number, error_message",
    limit: 10,
  });
  const apps = useProjectRows<MobileApp>("mobile_apps", project.id, {
    select: "id, platform, bundle_identifier, display_name, subtitle, short_description, full_description, keywords, category, privacy_policy_url, icon_path",
    realtime: false,
    pollMs: open ? 15_000 : undefined,
  });

  const latest = useMemo(() => latestPerPlatform(submissions.rows), [submissions.rows]);
  const hasPipeline = latest.length > 0;
  const [step, setStep] = useState<Step>("platforms");
  const [platforms, setPlatforms] = useState<Platform[]>(["android", "ios"]);
  const [apple, setApple] = useState<{ id: string; display_name: string } | null | undefined>(undefined);
  const [google, setGoogle] = useState<GoogleAccount | null | undefined>(undefined);
  const [closedTest, setClosedTest] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);

  // Open on the tracker when something is already in the stores' pipeline.
  useEffect(() => {
    if (open) setStep(hasPipeline ? "tracker" : "platforms");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void browserClient()
      .from("publisher_accounts")
      .select("id, display_name")
      .eq("platform", "ios")
      .eq("kind", "customer")
      .eq("status", "verified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => setApple((data as { id: string; display_name: string } | null) ?? null));
    void loadGoogleAccount().then(setGoogle);
  }, [open]);

  // Prefill the listing from what was submitted last time.
  useEffect(() => {
    if (listing || apps.loading) return;
    const a = apps.rows[0];
    setListing({
      displayName: a?.display_name ?? project.name.slice(0, 30),
      subtitle: a?.subtitle ?? "",
      shortDescription: a?.short_description ?? "",
      fullDescription: a?.full_description ?? "",
      keywords: a?.keywords ?? "",
      category: a?.category ?? "shopping",
      privacyPolicyUrl: a?.privacy_policy_url ?? "",
      iconPath: a?.icon_path ?? null,
    });
  }, [apps.loading, apps.rows, listing, project.name]);

  const steps: Step[] = [
    "platforms",
    ...(platforms.includes("android") ? (["google"] as const) : []),
    ...(platforms.includes("ios") ? (["apple"] as const) : []),
    "listing",
    "review",
  ];
  const index = steps.indexOf(step);
  const next = () => setStep(steps[Math.min(index + 1, steps.length - 1)] ?? "review");
  const back = () => setStep(steps[Math.max(index - 1, 0)] ?? "platforms");

  return (
    <Dialog open={open} onClose={onClose} title={t("store.title")} wide>
      {step !== "tracker" && (
        <ol className="mb-5 flex items-center gap-2 text-xs">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={cn(
                  "grid size-6 place-items-center rounded-full font-semibold",
                  i < index ? "bg-primary text-primary-foreground" : i === index ? "bg-accent text-primary ring-2 ring-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {i < index ? <Check className="size-3.5" /> : i + 1}
              </span>
              <span className={cn("max-sm:hidden", i === index ? "font-medium" : "text-muted-foreground")}>{t(`store.step.${s}` as MessageKey)}</span>
              {i < steps.length - 1 && <span className="h-px w-4 bg-border" />}
            </li>
          ))}
          {hasPipeline && (
            <li className="ms-auto">
              <Button size="sm" variant="ghost" onClick={() => setStep("tracker")}>
                {t("store.tracker")}
              </Button>
            </li>
          )}
        </ol>
      )}

      {step === "platforms" && <PlatformsStep value={platforms} onChange={setPlatforms} onNext={next} />}
      {step === "google" && <GoogleStep account={google} onConnected={(a) => { setGoogle(a); next(); }} onNext={next} onBack={back} />}
      {step === "apple" && <AppleStep account={apple} onConnected={(a) => { setApple(a); next(); }} onNext={next} onBack={back} />}
      {step === "listing" && listing && (
        <ListingStep projectId={project.id} platforms={platforms} value={listing} onChange={setListing} onNext={next} onBack={back} />
      )}
      {step === "review" && listing && (
        <ReviewStep
          projectId={project.id}
          platforms={platforms}
          listing={listing}
          appleAccountId={apple?.id}
          googleAccountId={google?.id}
          onBack={back}
          onNeedApple={() => setStep("apple")}
          onNeedGoogle={() => setStep("google")}
          onSubmitted={(res) => {
            setClosedTest(!!res?.closedTestRequired);
            void submissions.reload();
            void builds.reload();
            void apps.reload();
            setStep("tracker");
          }}
        />
      )}
      {step === "tracker" && closedTest && <ClosedTestNotice account={google ?? null} />}
      {step === "tracker" && (
        <Tracker
          latest={latest}
          builds={builds.rows}
          apps={apps.rows}
          onNew={() => setStep("platforms")}
          busy={latest.some((s) => ACTIVE.has(s.status)) || builds.rows.some((b) => ["queued", "in_progress"].includes(b.status))}
        />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
function PlatformsStep({ value, onChange, onNext }: { value: Platform[]; onChange: (v: Platform[]) => void; onNext: () => void }) {
  const t = useT();
  const toggle = (p: Platform) => onChange(value.includes(p) ? value.filter((x) => x !== p) : [...value, p]);
  const options: { p: Platform; icon: React.ReactNode; label: MessageKey; note: MessageKey }[] = [
    { p: "android", icon: <Smartphone className="size-5" />, label: "store.android", note: "store.androidNote" },
    { p: "ios", icon: <Apple className="size-5" />, label: "store.ios", note: "store.iosNote" },
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("store.platformsIntro")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((o) => {
          const on = value.includes(o.p);
          return (
            <button
              key={o.p}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => toggle(o.p)}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-4 text-start transition",
                on ? "border-primary bg-accent" : "border-border hover:bg-muted",
              )}
            >
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-lg", on ? "bg-primary text-primary-foreground" : "bg-muted")}>{o.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t(o.label)}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t(o.note)}</span>
              </span>
              {on ? <CheckCircle2 className="size-5 text-primary" /> : <Circle className="size-5 text-muted-foreground" />}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button onClick={onNext} disabled={value.length === 0}>{t("common.next")}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AppleStep({
  account,
  onConnected,
  onNext,
  onBack,
}: {
  account: { id: string; display_name: string } | null | undefined;
  onConnected: (a: { id: string; display_name: string }) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState({ displayName: "", teamId: "", keyId: "", issuerId: "", privateKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  if (account === undefined) return <Spinner />;
  if (account) {
    return (
      <div className="space-y-4">
        <Alert tone="success" className="flex items-center gap-2">
          <CheckCircle2 className="size-4" />
          {t("store.appleConnected")}: <strong>{account.display_name}</strong>
        </Alert>
        <Nav onBack={onBack} onNext={onNext} />
      </div>
    );
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ publisher: { id: string; display_name: string } }>("/api/publisher-accounts/apple", {
        body: { ...form, teamId: form.teamId.trim().toUpperCase(), keyId: form.keyId.trim().toUpperCase(), issuerId: form.issuerId.trim() },
      });
      onConnected(res.publisher);
    } catch (err) {
      if (err instanceof ApiError && err.code === "apple_key_rejected") setError(t("store.err.appleRejected"));
      else if (err instanceof ApiError && err.code === "apple_key_invalid") setError(t("store.err.p8Invalid"));
      else if (err instanceof ApiError && err.code === "invalid_request") setError(t("store.err.appleFields"));
      else setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={connect} className="space-y-4">
      <p className="text-sm">{t("store.appleIntro")}</p>
      <Alert tone="info" className="flex gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0" />
        <span>{t("store.appleSteps")}</span>
      </Alert>
      <Field label={t("store.sellerName")}>
        <Input value={form.displayName} onChange={set("displayName")} required maxLength={120} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("store.teamId")}>
          <Input value={form.teamId} onChange={set("teamId")} required pattern="[A-Za-z0-9]{10}" dir="ltr" className="ltr font-mono" spellCheck={false} />
        </Field>
        <Field label={t("store.keyId")}>
          <Input value={form.keyId} onChange={set("keyId")} required pattern="[A-Za-z0-9]{10}" dir="ltr" className="ltr font-mono" spellCheck={false} />
        </Field>
      </div>
      <Field label={t("store.issuerId")}>
        <Input value={form.issuerId} onChange={set("issuerId")} required dir="ltr" className="ltr font-mono" spellCheck={false} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </Field>
      <Field label={t("store.p8")}>
        <Input
          type="file"
          accept=".p8"
          required
          className="py-2"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            const text = file && file.size < 4000 ? await file.text() : "";
            if (file && !text.includes("BEGIN PRIVATE KEY")) setError(t("store.err.p8Invalid"));
            else setError(null);
            setForm((f) => ({ ...f, privateKey: text.includes("BEGIN PRIVATE KEY") ? text : "" }));
          }}
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onBack}>{t("common.back")}</Button>
        <Button type="submit" loading={busy} disabled={!form.privateKey}>{t("store.connect")}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
function ListingStep({
  projectId,
  platforms,
  value,
  onChange,
  onNext,
  onBack,
}: {
  projectId: string;
  platforms: Platform[];
  value: Listing;
  onChange: (v: Listing) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const ios = platforms.includes("ios");
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [iconError, setIconError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const set = (k: keyof Listing) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    onChange({ ...value, [k]: e.target.value });

  useEffect(() => {
    if (!value.iconPath) return;
    void browserClient()
      .storage.from("project-assets")
      .createSignedUrl(value.iconPath, 600)
      .then(({ data }) => setIconUrl(data?.signedUrl ?? null));
  }, [value.iconPath]);

  async function uploadIcon(file: File) {
    setIconError(null);
    if (!(await isValidStoreIcon(file))) return setIconError(t("store.iconBad"));
    setUploading(true);
    const path = `${projectId}/icon-${Date.now()}.png`;
    const { error } = await browserClient().storage.from("project-assets").upload(path, file, { contentType: "image/png", upsert: false });
    setUploading(false);
    if (error) return setIconError(t("common.error"));
    onChange({ ...value, iconPath: path });
  }

  const valid =
    value.displayName.trim().length >= 2 &&
    value.shortDescription.trim().length >= 10 &&
    value.fullDescription.trim().length >= 50 &&
    Boolean(value.iconPath) &&
    (!value.privacyPolicyUrl || /^https:\/\//.test(value.privacyPolicyUrl));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <label className="group relative grid size-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-[22%] border border-dashed border-border bg-muted">
          {iconUrl ? <img src={iconUrl} alt="" className="size-full object-cover" /> : uploading ? <Spinner /> : <ImageUp className="size-6 text-muted-foreground" />}
          <input type="file" accept="image/png" className="sr-only" onChange={(e) => e.target.files?.[0] && uploadIcon(e.target.files[0])} />
        </label>
        <div className="text-sm">
          <p className="font-medium">{t("store.icon")}</p>
          {iconError ? <p className="text-xs text-danger">{iconError}</p> : <p className="text-xs text-muted-foreground">{t("store.iconHint")}</p>}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("store.appName")}>
          <Input value={value.displayName} onChange={set("displayName")} maxLength={30} required />
        </Field>
        <Field label={t("store.category")}>
          <select value={value.category} onChange={set("category")} className="h-10 w-full rounded-xl border border-border bg-card px-3 text-sm focus:outline-none focus:ring-4 focus:ring-ring">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(`store.cat.${c}` as MessageKey)}</option>
            ))}
          </select>
        </Field>
      </div>
      {ios && (
        <Field label={t("store.subtitle")}>
          <Input value={value.subtitle} onChange={set("subtitle")} maxLength={30} />
        </Field>
      )}
      <Field label={t("store.short")} hint={`${value.shortDescription.length}/80`}>
        <Input value={value.shortDescription} onChange={set("shortDescription")} maxLength={80} minLength={10} required />
      </Field>
      <Field label={t("store.full")} hint={`${value.fullDescription.length}/4000 · ${t("store.fullHint")}`}>
        <Textarea value={value.fullDescription} onChange={set("fullDescription")} maxLength={4000} rows={5} />
      </Field>
      {ios && (
        <Field label={t("store.keywords")} hint={`${value.keywords.length}/100`}>
          <Input value={value.keywords} onChange={set("keywords")} maxLength={100} />
        </Field>
      )}
      <Field label={t("store.privacy")}>
        <Input value={value.privacyPolicyUrl} onChange={set("privacyPolicyUrl")} type="url" dir="ltr" className="ltr" placeholder="https://" />
      </Field>
      <Nav onBack={onBack} onNext={onNext} nextDisabled={!valid} />
    </div>
  );
}

/** Store icons: 1024×1024 PNG with no transparency (App Store rejects alpha). */
async function isValidStoreIcon(file: File): Promise<boolean> {
  if (file.type !== "image/png" || file.size > 5 * 1024 * 1024) return false;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap || bitmap.width !== 1024 || bitmap.height !== 1024) return false;
  const canvas = new OffscreenCanvas(1024, 1024);
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, 1024, 1024);
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return false;
  return true;
}

// ---------------------------------------------------------------------------
function ReviewStep({
  projectId,
  platforms,
  listing,
  appleAccountId,
  googleAccountId,
  onBack,
  onNeedApple,
  onNeedGoogle,
  onSubmitted,
}: {
  projectId: string;
  platforms: Platform[];
  listing: Listing;
  appleAccountId?: string;
  googleAccountId?: string;
  onBack: () => void;
  onNeedApple: () => void;
  onNeedGoogle: () => void;
  onSubmitted: (res?: { closedTestRequired?: boolean; androidTrack?: string }) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; reasons?: string[] } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ closedTestRequired?: boolean; androidTrack?: string }>("/api/mobile/build-and-submit", {
        body: {
          projectId,
          platforms,
          iosPublisherAccountId: appleAccountId,
          androidPublisherAccountId: googleAccountId,
          listing: {
            displayName: listing.displayName.trim(),
            subtitle: listing.subtitle.trim() || undefined,
            shortDescription: listing.shortDescription.trim(),
            fullDescription: listing.fullDescription.trim(),
            keywords: listing.keywords.trim() || undefined,
            category: listing.category,
            privacyPolicyUrl: listing.privacyPolicyUrl.trim() || undefined,
            iconPath: listing.iconPath,
          },
        },
      });
      onSubmitted(res);
    } catch (err) {
      if (!(err instanceof ApiError)) setError({ text: t("common.error") });
      else if (err.code === "apple_account_required") onNeedApple();
      else if (err.code === "google_account_required") onNeedGoogle();
      else if (err.code === "store_publishing_locked") setError({ text: t("store.locked") });
      else if (err.code === "app_limit_reached") setError({ text: t("publish.appLimit") });
      else if (err.code === "store_policy_violation") setError({ text: t("store.policy"), reasons: (err.details as { reasons?: string[] } | undefined)?.reasons });
      else if (err.code === "build_in_progress") setError({ text: t("store.err.inProgress") });
      else if (err.code === "backend_not_ready") setError({ text: t("store.err.backend") });
      else setError({ text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("store.reviewIntro")}</p>
      <dl className="divide-y divide-border rounded-xl border border-border text-sm">
        <Row label={t("store.step.platforms")}>
          <span className="flex gap-1.5">
            {platforms.map((p) => <Badge key={p}>{p === "ios" ? "iOS" : "Android"}</Badge>)}
          </span>
        </Row>
        <Row label={t("store.appName")}>{listing.displayName}</Row>
        <Row label={t("store.short")}>{listing.shortDescription}</Row>
        <Row label={t("store.category")}>{t(`store.cat.${listing.category}` as MessageKey)}</Row>
      </dl>
      {platforms.includes("ios") && <Alert tone="info">{t("store.iosReviewNote")}</Alert>}
      {error && (
        <Alert tone="danger">
          <p>{error.text}</p>
          {error.reasons && (
            <ul className="mt-1 list-disc ps-5">
              {error.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
        </Alert>
      )}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>{t("common.back")}</Button>
        <Button onClick={submit} loading={busy}>{t("store.submit")}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function Tracker({ latest, builds, apps, onNew, busy }: { latest: Submission[]; builds: Build[]; apps: MobileApp[]; onNew: () => void; busy: boolean }) {
  const t = useT();
  const ago = useRelativeTime();
  return (
    <div className="space-y-4">
      <h3 className="font-medium">{t("store.tracker")}</h3>
      {latest.map((s) => {
        const build = builds.find((b) => b.id === s.mobile_build_id);
        const app = apps.find((a) => a.platform === s.platform);
        return (
          <div key={s.id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-center gap-2">
              {s.platform === "ios" ? <Apple className="size-5" /> : <Smartphone className="size-5" />}
              <span className="font-medium">{s.platform === "ios" ? "App Store" : "Google Play"}</span>
              {build && (
                <span className="ltr text-xs text-muted-foreground" dir="ltr">
                  {build.app_version} ({build.build_number})
                </span>
              )}
              <div className="flex-1" />
              <StatusBadge status={s.status} />
            </div>

            <ol className="mt-4 space-y-0">
              {build && <TimelineItem label={`${t("store.build")}`} status={build.status} detail={build.error_message} />}
              {s.status_history.map((h, i) => (
                <TimelineItem
                  key={`${h.status}-${i}`}
                  label={t(`status.${h.status}` as MessageKey)}
                  status={h.status}
                  at={ago(h.at)}
                  detail={h.reason}
                  passed={i < s.status_history.length - 1}
                />
              ))}
            </ol>

            {s.status === "awaiting_store_setup" && app && (
              <Alert tone="warning" className="mt-3 space-y-2">
                <p>{s.platform === "ios" ? t("store.setupIos") : t("store.setupAndroid")}</p>
                {s.platform === "ios" && (
                  <code className="ltr block rounded-lg bg-card px-3 py-2 font-mono text-sm" dir="ltr">{app.bundle_identifier}</code>
                )}
              </Alert>
            )}
            {s.status === "rejected" && s.rejection_reason && (
              <Alert tone="danger" className="mt-3">{s.rejection_reason}</Alert>
            )}
            {s.store_url && (
              <a href={s.store_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                {t("store.openStore")}
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        );
      })}
      <div className="flex justify-end">
        <Button variant="outline" onClick={onNew} disabled={busy}>{t("store.newRelease")}</Button>
      </div>
    </div>
  );
}

function TimelineItem({ label, status, at, detail, passed }: { label: string; status: string; at?: string; detail?: string | null; passed?: boolean }) {
  const bad = !passed && ["errored", "failed", "rejected", "canceled", "removed"].includes(status);
  const done = passed || ["finished", "approved", "published"].includes(status);
  const current = !bad && !done;
  return (
    <li className="relative flex gap-3 pb-3 ps-1 last:pb-0">
      <span className="absolute start-[0.6rem] top-5 h-[calc(100%-1rem)] w-px bg-border" aria-hidden />
      <span className="relative z-10 mt-0.5 grid size-4 place-items-center rounded-full bg-card">
        {bad ? (
          <XCircle className="size-4 text-danger" />
        ) : done ? (
          <CheckCircle2 className="size-4 text-primary" />
        ) : (
          <Circle className="size-4 animate-pulse fill-warning/30 text-warning" />
        )}
      </span>
      <div className="min-w-0 text-sm">
        <span className={cn(current && "font-medium")}>{label}</span>
        {at && <span className="ms-2 text-xs text-muted-foreground">{at}</span>}
        {detail && <p className="text-xs text-danger">{detail}</p>}
      </div>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-3 py-2.5">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function Nav({ onBack, onNext, nextDisabled }: { onBack: () => void; onNext: () => void; nextDisabled?: boolean }) {
  const t = useT();
  return (
    <div className="flex justify-between gap-2">
      <Button variant="ghost" onClick={onBack}>{t("common.back")}</Button>
      <Button onClick={onNext} disabled={nextDisabled}>{t("common.next")}</Button>
    </div>
  );
}

function latestPerPlatform(rows: Submission[]): Submission[] {
  const seen = new Map<Platform, Submission>();
  for (const r of rows) if (!seen.has(r.platform)) seen.set(r.platform, r); // rows are newest first
  return [...seen.values()];
}
