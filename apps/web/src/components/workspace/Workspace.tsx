"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Database, FileText, Globe, History, MessageSquare, MonitorSmartphone, RefreshCw, Rocket, Settings } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Button, cn } from "@/components/ui/index";
import { useProjectRows } from "@/hooks/useProjectRows";
import { browserClient } from "@/lib/supabase/browser";
import { api, ApiError } from "@/lib/api-client";
import { useT } from "@/i18n/client";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { PreviewPanel } from "@/components/workspace/PreviewPanel";
import { VersionHistory } from "@/components/workspace/VersionHistory";
import { WebPublishDialog } from "@/components/publish/WebPublishDialog";
import { StorePublishDialog } from "@/components/publish/StorePublishDialog";
import { OtaDialog } from "@/components/publish/OtaDialog";
import { SpecPanel, type SpecRow } from "@/components/spec/SpecPanel";
import { ProjectSettingsDialog } from "@/components/settings/ProjectSettingsDialog";
import { Dialog } from "@/components/ui/index";
import { useStrings } from "@/i18n/strings";
import { CREDIT_HOLD } from "@banna/shared/credit-rules";

export interface WorkspaceProject {
  id: string;
  name: string;
  slug: string;
  status: string;
  current_version_id: string | null;
  vercel_project_id: string | null;
}

export interface VersionRow {
  id: string;
  version_number: number;
  prompt: string | null;
  summary: string | null;
  source: string;
  created_at: string;
}

export interface DeploymentRow {
  id: string;
  version_id: string;
  target: "preview" | "production";
  status: string;
  url: string | null;
  alias_url: string | null;
  created_at: string;
}

type Panel = "chat" | "preview";
type DialogName = "web" | "stores" | "ota" | "history" | "spec" | "settings" | null;

const WS = {
  ar: { specWaiting: "تعديل جوهري ينتظر مراجعتك للمواصفات قبل البناء.", review: "راجع المواصفات", specTitle: "مراجعة المواصفات", settings: "الإعدادات" },
  en: { specWaiting: "A substantive change is waiting for you to review the spec before it is built.", review: "Review spec", specTitle: "Spec review", settings: "Settings" },
};

export function Workspace({ project: initial, credits: initialCredits, rootDomain }: { project: WorkspaceProject; credits: number; rootDomain: string }) {
  const t = useT();
  const [project, setProject] = useState(initial);
  const [credits, setCredits] = useState(initialCredits);
  const [panel, setPanel] = useState<Panel>("chat");
  const [dialog, setDialog] = useState<DialogName>(null);
  const ws = useStrings(WS);
  const specs = useProjectRows<Pick<SpecRow, "id" | "status">>("app_specs", project.id, { select: "id, status", limit: 3 });
  const pendingSpec = specs.rows.some((r) => r.status === "draft");

  const versions = useProjectRows<VersionRow>("project_versions", project.id, {
    select: "id, version_number, prompt, summary, source, created_at",
    orderBy: "version_number",
    ascending: true,
    limit: 200,
  });
  const deployments = useProjectRows<DeploymentRow>("web_deployments", project.id, {
    select: "id, version_id, target, status, url, alias_url, created_at",
    limit: 20,
  });
  const backend = useProjectRows<{ id: string; status: string; last_error: string | null }>("app_backends", project.id, {
    select: "id, status, last_error",
    realtime: false, // column-level grants hide secret ids; poll instead
    pollMs: 10_000,
  });

  // Live project row (status / current version / name)
  const reloadProject = useCallback(async () => {
    const { data } = await browserClient()
      .from("projects")
      .select("id, name, slug, status, current_version_id, vercel_project_id")
      .eq("id", project.id)
      .single();
    if (data) setProject(data as WorkspaceProject);
  }, [project.id]);

  const reloadCredits = useCallback(async () => {
    const { data: auth } = await browserClient().auth.getUser();
    if (!auth.user) return;
    const { data } = await browserClient().from("profiles").select("credits_balance").eq("id", auth.user.id).single();
    if (data) setCredits(data.credits_balance as number);
  }, []);

  useEffect(() => {
    const ch = browserClient()
      .channel(`project:${project.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "projects", filter: `id=eq.${project.id}` }, () => void reloadProject())
      .subscribe();
    return () => void browserClient().removeChannel(ch);
  }, [project.id, reloadProject]);

  const production = useMemo(() => deployments.rows.find((d) => d.target === "production"), [deployments.rows]);
  const backendStatus = backend.rows[0]?.status;

  /** After each generation, build a preview deployment of the new version (iframe + QR). */
  const buildPreview = useCallback(
    async (versionId?: string) => {
      try {
        await api("/api/deploy/web", { body: { projectId: project.id, versionId, target: "preview" } });
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) console.error(err);
      }
      void deployments.reload();
    },
    [project.id, deployments],
  );

  const onGenerated = useCallback(async () => {
    await Promise.all([reloadProject(), versions.reload(), reloadCredits(), backend.reload()]);
  }, [reloadProject, versions, reloadCredits, backend]);

  // Every new current version (chat edit, or a build the worker made from an approved spec) gets a preview.
  const lastVersion = useRef(initial.current_version_id);
  useEffect(() => {
    const id = project.current_version_id;
    if (!id || id === lastVersion.current) return;
    lastVersion.current = id;
    void versions.reload();
    void reloadCredits();
    void buildPreview(id);
  }, [project.current_version_id, buildPreview, versions, reloadCredits]);

  return (
    <div className="flex h-dvh flex-col">
      <AppHeader credits={credits}>
        <Link href="/dashboard" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted" aria-label={t("dash.title")} title={t("dash.title")}>
          <ArrowRight className="size-4 ltr:rotate-180" aria-hidden />
        </Link>
        <h1 className="min-w-0 truncate font-medium">{project.name}</h1>
        <span className="max-sm:hidden">
          <StatusBadge status={project.status} />
        </span>
        {backendStatus && backendStatus !== "active" && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground md:inline-flex" title={t("ws.backend")}>
            <Database className="size-3.5" />
            <StatusBadge status={backendStatus} />
          </span>
        )}
      </AppHeader>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Button variant="ghost" size="sm" onClick={() => setDialog("history")} disabled={!versions.rows.length}>
          <History className="size-4" />
          {t("ws.history")}
          {versions.rows.length > 0 && <span className="ltr text-xs text-muted-foreground">v{versions.rows.at(-1)!.version_number}</span>}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDialog("settings")}>
          <Settings className="size-4" />
          {ws.settings}
        </Button>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => setDialog("web")} disabled={!project.current_version_id}>
          <Globe className="size-4" />
          {t("ws.publishWeb")}
          {production && <StatusBadge status={production.status} />}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog("ota")} disabled={!project.current_version_id}>
          <RefreshCw className="size-4" />
          {t("ws.updateApp")}
        </Button>
        <Button size="sm" onClick={() => setDialog("stores")} disabled={!project.current_version_id}>
          <Rocket className="size-4" />
          {t("ws.publishStores")}
        </Button>
      </div>

      {/* Mobile tab switch */}
      <div className="flex border-b border-border lg:hidden" role="tablist">
        {(["chat", "preview"] as const).map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={panel === p}
            onClick={() => setPanel(p)}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 py-2.5 text-sm",
              panel === p ? "border-b-2 border-primary font-medium" : "text-muted-foreground",
            )}
          >
            {p === "chat" ? <MessageSquare className="size-4" /> : <MonitorSmartphone className="size-4" />}
            {t(p === "chat" ? "ws.chat" : "ws.preview")}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <section className={cn("flex min-h-0 w-full flex-col border-border lg:w-[420px] lg:border-e", panel !== "chat" && "max-lg:hidden")}>
          {!project.current_version_id ? (
            // a new app starts from an approved spec (FR-002a); the chat comes after the first build
            <SpecPanel projectId={project.id} generating={project.status === "generating"} onApproved={() => void reloadCredits()} />
          ) : (
            <>
              {pendingSpec && (
                <div className="flex items-center gap-2 border-b border-border bg-accent px-4 py-2 text-sm">
                  <FileText className="size-4 shrink-0 text-primary" />
                  <span className="flex-1">{ws.specWaiting}</span>
                  <Button size="sm" onClick={() => setDialog("spec")}>{ws.review}</Button>
                </div>
              )}
              <ChatPanel
                projectId={project.id}
                versions={versions.rows}
                generating={project.status === "generating"}
                isNew={false}
                onGenerated={onGenerated}
              />
            </>
          )}
        </section>
        <section className={cn("min-h-0 min-w-0 flex-1", panel !== "preview" && "max-lg:hidden")}>
          <PreviewPanel
            currentVersionId={project.current_version_id}
            deployments={deployments.rows}
            onBuild={() => buildPreview(project.current_version_id ?? undefined)}
            productionUrl={production?.status === "ready" ? `https://${project.slug}.${rootDomain}` : null}
          />
        </section>
      </div>

      <VersionHistory
        open={dialog === "history"}
        onClose={() => setDialog(null)}
        projectId={project.id}
        versions={versions.rows}
        currentVersionId={project.current_version_id}
        onRestored={async () => {
          await reloadProject(); // the version effect builds its preview
        }}
      />
      <WebPublishDialog
        open={dialog === "web"}
        onClose={() => setDialog(null)}
        project={project}
        production={production ?? null}
        defaultUrl={`https://${project.slug}.${rootDomain}`}
        onDeployed={() => {
          void deployments.reload();
          void reloadProject();
        }}
      />
      <Dialog open={dialog === "spec"} onClose={() => setDialog(null)} title={ws.specTitle} wide>
        <SpecPanel
          projectId={project.id}
          generating={project.status === "generating"}
          compact
          buildCost={CREDIT_HOLD.edit}
          onApproved={() => {
            setDialog(null);
            void reloadCredits();
          }}
        />
      </Dialog>
      <ProjectSettingsDialog open={dialog === "settings"} onClose={() => setDialog(null)} project={project} />
      <StorePublishDialog open={dialog === "stores"} onClose={() => setDialog(null)} project={project} />
      <OtaDialog
        open={dialog === "ota"}
        onClose={() => setDialog(null)}
        projectId={project.id}
        onNeedsRebuild={() => setDialog("stores")}
      />
    </div>
  );
}
