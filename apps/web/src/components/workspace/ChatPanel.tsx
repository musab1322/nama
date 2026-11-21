"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Database, Info, Lock, SendHorizontal, Sparkles, User } from "lucide-react";
import { Alert, Button, Textarea, cn } from "@/components/ui/index";
import { useProjectRows } from "@/hooks/useProjectRows";
import { api, ApiError } from "@/lib/api-client";
import { useT } from "@/i18n/client";
import type { VersionRow } from "@/components/workspace/Workspace";
import { CREDIT_HOLD } from "@banna/shared/credit-rules";
import { fill } from "@/i18n/strings";

interface GenerateResponse {
  /** null when the edit changes the spec: a new spec draft is written for approval first (FR-002b). */
  version: { id: string; version_number: number } | null;
  specChange: { jobId: number; reason: string } | null;
  summary: string;
  protectedFiles: string[];
  backendMigrations: { name: string; needsApproval: boolean }[];
  needsNativeChange: string | null;
}

interface Notice {
  versionId: string;
  protectedFiles: string[];
  needsNativeChange: string | null;
}

export function ChatPanel({
  projectId,
  versions,
  generating,
  isNew,
  onGenerated,
}: {
  projectId: string;
  versions: VersionRow[];
  generating: boolean;
  isNew: boolean;
  onGenerated: (versionId: string) => void | Promise<void>;
}) {
  const t = useT();
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [specNotice, setSpecNotice] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const blocked = useProjectRows<{ id: string; name: string; status: string }>("backend_migrations", projectId, {
    select: "id, name, status",
    realtime: false,
    pollMs: 15_000,
  });
  const blockedRows = blocked.rows.filter((m) => m.status === "blocked");

  // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [versions.length, pending, error]);

  const busy = pending !== null || generating;

  async function send() {
    const text = prompt.trim();
    if (text.length < 3 || busy) return;
    setPending(text);
    setPrompt("");
    setError(null);
    setNotice(null);
    setSpecNotice(null);
    try {
      const res = await api<GenerateResponse>("/api/generate", { body: { projectId, prompt: text } });
      if (!res.version) {
        setSpecNotice(res.specChange?.reason || t("ws.specChange"));
        return;
      }
      setNotice({ versionId: res.version.id, protectedFiles: res.protectedFiles, needsNativeChange: res.needsNativeChange });
      await onGenerated(res.version.id);
      void blocked.reload();
    } catch (err) {
      setPrompt(text); // give the text back so nothing is lost
      if (err instanceof ApiError && err.code === "insufficient_credits") setError(t("ws.insufficient"));
      else setError(err instanceof ApiError ? err.message : t("common.error"));
    } finally {
      setPending(null);
    }
  }

  async function approve(id: string) {
    await api(`/api/backend/migrations/${id}/approve`, { body: { confirm: "DELETE_DATA" } });
    void blocked.reload();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {versions.length === 0 && !pending && (
          <Bubble role="assistant">
            <p>{t("ws.welcome")}</p>
          </Bubble>
        )}
        {versions.map((v) => (
          <div key={v.id} className="space-y-3">
            {v.prompt && <Bubble role="user">{v.prompt}</Bubble>}
            <Bubble role="assistant">
              <p className="whitespace-pre-wrap">{v.summary}</p>
              <span className="ltr mt-1.5 block text-xs text-muted-foreground">v{v.version_number}</span>
              {notice?.versionId === v.id && (
                <div className="mt-2 space-y-1.5 text-xs">
                  {notice.protectedFiles.length > 0 && (
                    <p className="flex items-start gap-1.5 text-muted-foreground">
                      <Lock className="mt-0.5 size-3.5 shrink-0" />
                      {t("ws.protected")}: <span className="ltr">{notice.protectedFiles.join(", ")}</span>
                    </p>
                  )}
                  {notice.needsNativeChange && (
                    <p className="flex items-start gap-1.5 text-[oklch(0.5_0.12_75)]">
                      <Info className="mt-0.5 size-3.5 shrink-0" />
                      {t("ws.nativeNote")}: {notice.needsNativeChange}
                    </p>
                  )}
                </div>
              )}
            </Bubble>
          </div>
        ))}
        {specNotice && (
          <Bubble role="assistant">
            <p className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-4 shrink-0" />
              <span>
                {t("ws.specChange")} {specNotice !== t("ws.specChange") && <span className="text-muted-foreground">{specNotice}</span>}
              </span>
            </p>
          </Bubble>
        )}
        {pending && (
          <>
            <Bubble role="user">{pending}</Bubble>
            <Bubble role="assistant">
              <span className="flex items-center gap-2 text-muted-foreground">
                <Sparkles className="size-4 animate-pulse text-primary" />
                {t("ws.generating")}
              </span>
            </Bubble>
          </>
        )}
        {blockedRows.map((m) => (
          <Alert key={m.id} tone="warning" className="space-y-2">
            <p className="flex items-center gap-2 font-medium">
              <Database className="size-4" />
              {t("ws.needsApproval")}
            </p>
            <p className="ltr text-xs">{m.name}</p>
            <Button size="sm" variant="danger" onClick={() => approve(m.id)}>
              {t("ws.approve")}
            </Button>
          </Alert>
        ))}
        {error && <Alert tone="danger">{error}</Alert>}
        <div ref={endRef} />
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="relative">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t(isNew ? "ws.placeholder.new" : "ws.placeholder.edit")}
            rows={3}
            maxLength={20000}
            disabled={busy}
            className="resize-none pe-12"
            aria-label={t("ws.chat")}
          />
          <Button
            type="submit"
            size="icon"
            className="absolute bottom-2 end-2"
            disabled={prompt.trim().length < 3}
            loading={busy}
            aria-label={t("ws.send")}
          >
            {!busy && <SendHorizontal className="size-4 rtl:rotate-180" />}
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("ws.cost")}: {fill(t("ws.upTo"), { n: isNew ? CREDIT_HOLD.newApp : CREDIT_HOLD.edit })}
        </p>
      </form>
    </div>
  );
}

function Bubble({ role, children }: { role: "user" | "assistant"; children: React.ReactNode }) {
  const mine = role === "user";
  return (
    <div className={cn("flex items-start gap-2.5", mine && "flex-row-reverse")}>
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          mine ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
        )}
        aria-hidden
      >
        {mine ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
      </span>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          mine ? "rounded-se-sm bg-primary text-primary-foreground" : "rounded-ss-sm bg-muted",
        )}
      >
        {children}
      </div>
    </div>
  );
}
