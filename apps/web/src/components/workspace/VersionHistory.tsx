"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Alert, Badge, Button, Dialog } from "@/components/ui/index";
import { browserClient } from "@/lib/supabase/browser";
import { useRelativeTime, useT } from "@/i18n/client";
import type { VersionRow } from "@/components/workspace/Workspace";

export function VersionHistory({
  open,
  onClose,
  projectId,
  versions,
  currentVersionId,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  versions: VersionRow[];
  currentVersionId: string | null;
  onRestored: (versionId: string) => void | Promise<void>;
}) {
  const t = useT();
  const ago = useRelativeTime();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore(id: string) {
    setBusy(id);
    setError(null);
    setDone(false);
    // Versions are immutable; "restore" just moves the project's pointer (composite FK keeps it in-project).
    const { error } = await browserClient().from("projects").update({ current_version_id: id }).eq("id", projectId);
    setBusy(null);
    if (error) return setError(t("common.error"));
    setDone(true);
    await onRestored(id);
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("history.title")}>
      {done && <Alert tone="success" className="mb-3">{t("history.restored")}</Alert>}
      {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
      <ol className="space-y-2">
        {[...versions].reverse().map((v) => {
          const current = v.id === currentVersionId;
          return (
            <li key={v.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
              <span className="ltr grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold">v{v.version_number}</span>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm">{v.prompt ?? v.summary ?? `${t("history.version")} ${v.version_number}`}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{ago(v.created_at)}</p>
              </div>
              {current ? (
                <Badge tone="success">{t("history.current")}</Badge>
              ) : (
                <Button size="sm" variant="outline" onClick={() => restore(v.id)} loading={busy === v.id} disabled={busy !== null}>
                  <RotateCcw className="size-3.5" />
                  <span className="max-sm:sr-only">{t("history.restore")}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </Dialog>
  );
}
