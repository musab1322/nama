"use client";

import { useState } from "react";
import { CheckCircle2, RefreshCw, Rocket } from "lucide-react";
import { Alert, Button, Dialog, Field, Textarea } from "@/components/ui/index";
import { api, ApiError } from "@/lib/api-client";
import { useT } from "@/i18n/client";

type State = { kind: "idle" } | { kind: "sent" } | { kind: "rebuild" } | { kind: "notPublished" } | { kind: "error"; message: string };

export function OtaDialog({
  open,
  onClose,
  projectId,
  onNeedsRebuild,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onNeedsRebuild: () => void;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });

  async function push() {
    setBusy(true);
    setState({ kind: "idle" });
    try {
      await api("/api/mobile/ota-push", { body: { projectId, message: message.trim() || undefined, alsoDeployWeb: true } });
      setState({ kind: "sent" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "native_rebuild_required") setState({ kind: "rebuild" });
      else if (err instanceof ApiError && err.code === "no_published_app") setState({ kind: "notPublished" });
      else if (err instanceof ApiError && err.code === "store_policy_violation") setState({ kind: "error", message: `${t("store.policy")} ${err.message}` });
      else setState({ kind: "error", message: err instanceof ApiError ? err.message : t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setState({ kind: "idle" });
    setMessage("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={t("ota.title")}>
      {state.kind === "sent" ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-12 text-primary" />
          <p>{t("ota.sent")}</p>
          <Button onClick={close}>{t("common.close")}</Button>
        </div>
      ) : state.kind === "rebuild" ? (
        <div className="space-y-4">
          <Alert tone="warning">{t("ota.needsRebuild")}</Alert>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
            <Button onClick={() => { setState({ kind: "idle" }); onNeedsRebuild(); }}>
              <Rocket className="size-4" />
              {t("ota.rebuild")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("ota.confirm")}</p>
          {state.kind === "notPublished" && <Alert tone="info">{t("ota.notPublished")}</Alert>}
          {state.kind === "error" && <Alert tone="danger">{state.message}</Alert>}
          <Field label={t("ota.note")}>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={2} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
            <Button onClick={push} loading={busy} disabled={state.kind === "notPublished"}>
              {!busy && <RefreshCw className="size-4" />}
              {t("ota.push")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
