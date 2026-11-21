// Payments through the app owner's own Moyasar account (FR-014). Platform-owned.
// Secrets (set by the platform, never in the app bundle): MOYASAR_SECRET_KEY, APP_SITE_URL, APP_SCHEME.
// Deployed with verify_jwt = false because Moyasar calls the webhook without a user token;
// create/verify check the user's token themselves.
import { createClient } from "npm:@supabase/supabase-js@2";

const MOYASAR = "https://api.moyasar.com/v1";
const url = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function moyasar(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("MOYASAR_SECRET_KEY");
  if (!key) throw new Error("payments_not_configured");
  return fetch(`${MOYASAR}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${btoa(`${key}:`)}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function allowedReturn(u: string): boolean {
  const site = Deno.env.get("APP_SITE_URL") ?? "";
  const scheme = Deno.env.get("APP_SCHEME") ?? "";
  return (!!site && (u === site || u.startsWith(`${site}/`))) || (!!scheme && u.startsWith(`${scheme}://`));
}

/** Re-reads the invoice from Moyasar (never trusts a caller) and settles the payment once. */
async function settle(row: { id: string; provider_ref: string | null; amount_halalas: number; reference_type: string; reference_id: string }) {
  if (!row.provider_ref) return "failed";
  const res = await moyasar(`/invoices/${encodeURIComponent(row.provider_ref)}`);
  if (!res.ok) return "initiated";
  const inv = await res.json();
  if (inv.status === "paid" && inv.amount === row.amount_halalas && inv.currency === "SAR") {
    const { data } = await admin
      .from("app_payments")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "initiated")
      .select("id");
    if (data?.length) {
      await admin.rpc("on_payment_paid", { p_reference_type: row.reference_type, p_reference_id: row.reference_id });
    }
    return "paid";
  }
  const final = ({ expired: "expired", failed: "failed", canceled: "failed", voided: "failed", refunded: "refunded" } as Record<string, string>)[inv.status];
  if (final) {
    await admin.from("app_payments").update({ status: final, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "initiated");
    return final;
  }
  return "initiated";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  const query = new URL(req.url).searchParams;

  if (query.get("webhook") === "1") {
    const body = await req.json().catch(() => ({}));
    const invoiceId = typeof body?.id === "string" ? body.id : null;
    if (!invoiceId) return json(400, { error: "bad webhook" });
    const { data: row } = await admin.from("app_payments").select("*").eq("provider_ref", invoiceId).maybeSingle();
    if (row) await settle(row);
    return json(200, { ok: true });
  }

  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: auth } = await userClient.auth.getUser();
  if (!auth.user) return json(401, { error: "Unauthorized" });
  const body = await req.json().catch(() => ({}));

  try {
    if (body.action === "create") {
      const { referenceType, referenceId, returnUrl } = body;
      if (typeof referenceType !== "string" || typeof referenceId !== "string") return json(400, { error: "bad reference" });
      if (typeof returnUrl !== "string" || !allowedReturn(returnUrl)) return json(400, { error: "bad return url" });

      const { data: amount, error: amountError } = await admin.rpc("payment_amount_for", {
        p_reference_type: referenceType,
        p_reference_id: referenceId,
        p_user_id: auth.user.id,
      });
      if (amountError || typeof amount !== "number" || amount < 100) return json(400, { error: amountError?.message ?? "nothing to pay" });

      const { data: row, error } = await admin
        .from("app_payments")
        .insert({ user_id: auth.user.id, reference_type: referenceType, reference_id: referenceId, amount_halalas: amount })
        .select("id")
        .single();
      if (error) throw error;

      const res = await moyasar("/invoices", {
        method: "POST",
        body: JSON.stringify({
          amount,
          currency: "SAR",
          description: `${referenceType} ${referenceId}`.slice(0, 255),
          callback_url: `${url}/functions/v1/payments?webhook=1`,
          success_url: returnUrl,
          back_url: returnUrl,
          metadata: { payment_id: row.id },
        }),
      });
      const invoice = await res.json();
      if (!res.ok) {
        await admin.from("app_payments").update({ status: "failed" }).eq("id", row.id);
        return json(502, { error: invoice?.message ?? "payment provider error" });
      }
      await admin.from("app_payments").update({ provider_ref: invoice.id }).eq("id", row.id);
      return json(200, { paymentId: row.id, url: invoice.url, status: "initiated" });
    }

    if (body.action === "verify") {
      const { data: row } = await admin
        .from("app_payments")
        .select("*")
        .eq("id", body.paymentId)
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (!row) return json(404, { error: "not found" });
      const status = row.status === "initiated" ? await settle(row) : row.status;
      return json(200, { status });
    }
    return json(400, { error: "unknown action" });
  } catch (err) {
    console.error(err);
    return json(500, { error: err instanceof Error && err.message === "payments_not_configured" ? "payments_not_configured" : "failed" });
  }
});
