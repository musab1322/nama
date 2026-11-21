"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Lock, RefreshCw, Trash2 } from "lucide-react";
import { Alert, Badge, Button, Dialog, Input, Spinner } from "@/components/ui/index";
import { StatusBadge } from "@/components/StatusBadge";
import { api, ApiError } from "@/lib/api-client";
import { useT } from "@/i18n/client";
import type { DeploymentRow, WorkspaceProject } from "@/components/workspace/Workspace";

interface DnsRecord {
  type: string;
  name: string;
  value: string;
}
interface DomainRow {
  id: string;
  hostname: string;
  is_apex: boolean;
  redirect_to: string | null;
  status: string;
  dns_records: DnsRecord[];
  verification_records: DnsRecord[];
  ssl_status: "pending" | "issued" | "failed";
  misconfigured_reason: string | null;
}

const BUSY = new Set(["queued", "building", "uploading"]);

export function WebPublishDialog({
  open,
  onClose,
  project,
  production,
  defaultUrl,
  onDeployed,
}: {
  open: boolean;
  onClose: () => void;
  project: WorkspaceProject;
  production: DeploymentRow | null;
  defaultUrl: string;
  onDeployed: () => void;
}) {
  const t = useT();
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = production?.status === "ready";
  const inFlight = production && BUSY.has(production.status);
  const upToDate = live && production?.version_id === project.current_version_id;

  async function publish() {
    setPublishing(true);
    setError(null);
    try {
      await api("/api/deploy/web", { body: { projectId: project.id, target: "production" } });
      onDeployed();
    } catch (err) {
      setError(
        !(err instanceof ApiError)
          ? t("common.error")
          : err.code === "app_limit_reached"
            ? t("publish.appLimit")
            : err.code === "plan_required"
              ? t("publish.planRequired")
              : err.message,
      );
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("web.title")} wide>
      <section className="space-y-3">
        {live ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-accent p-3">
            <Globe className="size-4 text-primary" />
            <span className="text-sm">{t("web.live")}</span>
            <a href={defaultUrl} target="_blank" rel="noopener noreferrer" className="ltr inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline" dir="ltr">
              {defaultUrl.replace("https://", "")}
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        ) : (
          !inFlight && <p className="text-sm text-muted-foreground">{t("web.never")}</p>
        )}
        {inFlight && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={production!.status} />
          </p>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button onClick={publish} loading={publishing || Boolean(inFlight)} disabled={Boolean(upToDate)}>
          {upToDate ? <Check className="size-4" /> : <Globe className="size-4" />}
          {upToDate ? t("web.upToDate") : live ? t("web.republish") : t("web.publish")}
        </Button>
      </section>

      <hr className="my-5 border-border" />

      <DomainManager projectId={project.id} enabled={Boolean(project.vercel_project_id)} />
    </Dialog>
  );
}

function DomainManager({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const t = useT();
  const [domains, setDomains] = useState<DomainRow[] | null>(null);
  const [hostname, setHostname] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ domains: DomainRow[] }>(`/api/domains?projectId=${projectId}`, { method: "GET" });
      setDomains(res.domains);
    } catch {
      setDomains([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    // Cron re-checks pending domains every 5 minutes; poll lightly while the dialog is open.
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, [enabled, load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!hostname.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await api("/api/domains", { body: { projectId, hostname: hostname.trim(), includeWww: true } });
      setHostname("");
      await load();
    } catch (err) {
      setError(domainError(err, t));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="space-y-3">
      <h3 className="font-medium">{t("web.domains")}</h3>
      {!enabled ? (
        <Alert tone="info">{t("web.publishFirst")}</Alert>
      ) : (
        <>
          <form onSubmit={add} className="flex gap-2">
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder={t("web.domainPlaceholder")}
              dir="ltr"
              className="ltr"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              aria-label={t("web.domains")}
            />
            <Button type="submit" loading={adding} disabled={hostname.trim().length < 4}>
              {t("web.addDomain")}
            </Button>
          </form>
          {error && <Alert tone="danger">{error}</Alert>}
          {domains === null ? (
            <Spinner />
          ) : (
            <ul className="space-y-3">
              {domains.map((d) => (
                <DomainCard key={d.id} domain={d} onChanged={load} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function DomainCard({ domain: d, onChanged }: { domain: DomainRow; onChanged: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState<"verify" | "remove" | null>(null);
  const records = [...d.verification_records, ...d.dns_records];
  const pending = d.status !== "active";

  async function verify() {
    setBusy("verify");
    try {
      await api(`/api/domains/${d.id}/verify`, { method: "POST" });
    } finally {
      setBusy(null);
      await onChanged();
    }
  }
  async function remove() {
    setBusy("remove");
    try {
      await api(`/api/domains/${d.id}`, { method: "DELETE" });
    } finally {
      setBusy(null);
      await onChanged();
    }
  }

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ltr font-medium" dir="ltr">{d.hostname}</span>
        <StatusBadge status={d.status} />
        {d.redirect_to && (
          <span className="ltr text-xs text-muted-foreground" dir="ltr">→ {d.redirect_to}</span>
        )}
        <div className="flex-1" />
        <Badge tone={d.ssl_status === "issued" ? "success" : "neutral"}>
          <Lock className="size-3" />
          {t("web.ssl")}: {d.ssl_status === "issued" ? t("web.sslIssued") : t("web.sslPending")}
        </Badge>
      </div>

      {pending && records.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">{t("web.dnsIntro")}</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">{t("web.type")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("web.name")}</th>
                  <th className="px-3 py-2 text-start font-medium">{t("web.value")}</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={`${r.type}-${r.name}-${i}`} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{r.type}</td>
                    <td className="ltr px-3 py-2 font-mono text-xs" dir="ltr">{r.name}</td>
                    <td className="ltr max-w-[16rem] truncate px-3 py-2 font-mono text-xs" dir="ltr" title={r.value}>{r.value}</td>
                    <td className="px-1">
                      <CopyButton value={r.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.misconfigured_reason && <p className="text-xs text-danger">{d.misconfigured_reason}</p>}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        {pending && (
          <Button size="sm" variant="outline" onClick={verify} loading={busy === "verify"} disabled={busy !== null}>
            <RefreshCw className="size-3.5" />
            {t("web.verify")}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="text-danger" onClick={remove} loading={busy === "remove"} disabled={busy !== null}>
          <Trash2 className="size-3.5" />
          {t("web.remove")}
        </Button>
      </div>
    </li>
  );
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8"
      aria-label={copied ? t("common.copied") : t("common.copy")}
      title={copied ? t("common.copied") : t("common.copy")}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

function domainError(err: unknown, t: ReturnType<typeof useT>): string {
  if (!(err instanceof ApiError)) return t("common.error");
  switch (err.code) {
    case "domain_taken":
      return t("web.err.taken");
    case "domain_in_use_elsewhere":
      return t("web.err.elsewhere");
    case "invalid_domain":
    case "reserved_domain":
    case "domain_rejected":
      return t("web.err.invalid");
    default:
      return err.message;
  }
}
