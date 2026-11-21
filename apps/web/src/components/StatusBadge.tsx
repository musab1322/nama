"use client";

import { Badge, Spinner, type Tone } from "@/components/ui/index";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/dict";

const TONE: Record<string, Tone> = {
  ready: "success", active: "success", published: "success", finished: "success", approved: "success",
  queued: "neutral", draft: "neutral", pending: "neutral", submitted: "info", archived: "neutral",
  building: "info", in_progress: "info", generating: "info", submitting: "info", uploading: "info",
  verifying: "info", provisioning: "info", in_review: "warning", awaiting_store_setup: "warning", misconfigured: "warning",
  error: "danger", errored: "danger", failed: "danger", rejected: "danger", canceled: "neutral", removed: "danger",
};
const BUSY = new Set(["building", "in_progress", "generating", "submitting", "uploading", "verifying", "provisioning", "queued"]);

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const t = useT();
  if (!status) return <Badge>{t("status.notPublished")}</Badge>;
  const key = `status.${status}` as MessageKey;
  return (
    <Badge tone={TONE[status] ?? "neutral"}>
      {BUSY.has(status) && <Spinner className="size-3" />}
      {t(key)}
    </Badge>
  );
}
