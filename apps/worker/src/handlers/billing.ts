import type { SupabaseClient } from "@supabase/supabase-js";
import { settleFromMoyasar } from "@banna/integrations/billing";
import { chargeToken, MoyasarError } from "@banna/integrations/moyasar";
import type { JobRow } from "../support";

/**
 * billing.renew (design §5.6, ADR-006): charges the saved card for the next month.
 * The payment row is created first and its id is Moyasar's given_id, so a retried
 * job never charges twice. Failures follow the 3-attempts-in-7-days schedule.
 */
export async function billingRenew(admin: SupabaseClient, job: JobRow) {
  const subscriptionId = job.payload.subscriptionId as string;
  const { data: due, error } = await admin.rpc("due_renewals", { p_limit: 500 });
  if (error) throw error;
  const row = ((due ?? []) as { subscription_id: string; user_id: string; plan_id: string; token: string; amount: number }[]).find(
    (r) => r.subscription_id === subscriptionId,
  );
  if (!row) return { skipped: "not_due" };

  const { data: sub } = await admin.from("subscriptions").select("current_period_end").eq("id", subscriptionId).single();
  const periodEnd = String(sub?.current_period_end);

  // reuse the open payment for this period if a previous attempt crashed after creating it
  const { data: open } = await admin
    .from("payments")
    .select("id, status")
    .eq("reference_id", subscriptionId)
    .eq("purpose", "subscription")
    .eq("metadata->>period_end", periodEnd)
    .in("status", ["initiated", "paid"])
    .maybeSingle();
  if (open?.status === "paid") return { skipped: "already_paid" };

  let paymentId = open?.id as string | undefined;
  if (!paymentId) {
    const { data: created, error: insErr } = await admin
      .from("payments")
      .insert({
        user_id: row.user_id,
        purpose: "subscription",
        plan_id: row.plan_id,
        reference_id: subscriptionId,
        amount_halalas: row.amount,
        metadata: { period_end: periodEnd, renewal: true },
      })
      .select("id")
      .single();
    if (insErr) throw insErr;
    paymentId = created.id as string;
  }

  let charge;
  try {
    charge = await chargeToken({
      givenId: paymentId,
      amount: row.amount,
      token: row.token,
      description: "Banna monthly plan",
      metadata: { payment_id: paymentId },
    });
  } catch (err) {
    if (err instanceof MoyasarError && err.status >= 400 && err.status < 500) {
      return fail(admin, subscriptionId, paymentId, err.message);
    }
    throw err; // network / 5xx: the job retries with the same given_id
  }

  if (charge.status === "paid") {
    const r = await settleFromMoyasar(admin, charge.id, { expectedPaymentId: paymentId, payment: charge });
    return { outcome: r.outcome };
  }
  // initiated = the bank wants 3-D Secure, which nobody can complete unattended
  const reason = charge.status === "initiated" ? "card requires verification (3-D Secure)" : (charge.source?.message ?? charge.status);
  return fail(admin, subscriptionId, paymentId, reason);
}

async function fail(admin: SupabaseClient, subscriptionId: string, paymentId: string, reason: string) {
  await admin.from("payments").update({ status: "failed", failure_reason: reason.slice(0, 300) }).eq("id", paymentId).eq("status", "initiated");
  const { data, error } = await admin.rpc("record_renewal_failure", { p_subscription_id: subscriptionId, p_reason: reason });
  if (error) throw error;
  return { outcome: data as string, reason };
}

