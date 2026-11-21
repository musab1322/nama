import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@banna/shared/jobs";
import { fetchPayment, type MoyasarPayment } from "./moyasar";

export type SettleOutcome =
  | "subscription_active"
  | "credits_added"
  | "hosting_paid"
  | "extra_app_added"
  | "extra_app_orphaned"
  | "paid"
  | "already_settled"
  | "amount_mismatch"
  | "not_paid"
  | "unknown_payment";

/**
 * Settles one of our payments from Moyasar's own record. Callers (return page,
 * webhook, renewal job) pass only a Moyasar payment id: amount, status and the
 * link to our payment row always come from Moyasar's API, never from the request.
 */
export async function settleFromMoyasar(
  admin: SupabaseClient,
  moyasarPaymentId: string,
  opts: { expectedPaymentId?: string; payment?: MoyasarPayment } = {},
): Promise<{ outcome: SettleOutcome; paymentId: string | null; moyasarStatus: string }> {
  const mp = opts.payment ?? (await fetchPayment(moyasarPaymentId));
  const paymentId = mp.metadata?.payment_id ?? null;
  if (!paymentId || (opts.expectedPaymentId && paymentId !== opts.expectedPaymentId)) {
    return { outcome: "unknown_payment", paymentId, moyasarStatus: mp.status };
  }
  if (mp.status !== "paid" || mp.currency !== "SAR") {
    if (mp.status === "failed") {
      await admin
        .from("payments")
        .update({ status: "failed", provider_payment_id: mp.id, failure_reason: (mp.source?.message ?? "failed").slice(0, 300) })
        .eq("id", paymentId)
        .eq("status", "initiated");
    }
    return { outcome: "not_paid", paymentId, moyasarStatus: mp.status };
  }
  const { data, error } = await admin.rpc("settle_platform_payment", {
    p_payment_id: paymentId,
    p_provider_payment_id: mp.id,
    p_amount: mp.amount,
    p_token: mp.source?.token ?? null,
  });
  if (error) throw error;
  const outcome = data as SettleOutcome;
  if (outcome === "subscription_active") await resumeLapsedBackends(admin, paymentId);
  return { outcome, paymentId, moyasarStatus: mp.status };
}

/** Paying again brings back the apps that were paused when the plan lapsed. */
async function resumeLapsedBackends(admin: SupabaseClient, paymentId: string) {
  const { data: pay } = await admin.from("payments").select("user_id").eq("id", paymentId).single();
  if (!pay) return;
  const { data: backends } = await admin
    .from("app_backends")
    .select("id, project_id, projects!inner(owner_id)")
    .eq("projects.owner_id", pay.user_id)
    .eq("status", "paused")
    .is("projects.suspended_at", null) // an admin suspension is not lifted by paying
    .like("last_error", "suspended: subscription_expired%");
  for (const b of backends ?? []) {
    await enqueueJob(admin, "backend.resume", { appBackendId: b.id }, { projectId: b.project_id as string, dedupeKey: `backend.resume:${b.id}`, maxAttempts: 30 });
  }
}
