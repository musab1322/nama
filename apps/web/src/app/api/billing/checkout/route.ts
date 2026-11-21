import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireUser, route } from "@/lib/http";
import { checkoutConfig } from "@banna/integrations/moyasar";
import { hasPaidPlan } from "@banna/backends/ensure";

export const runtime = "nodejs";

const Body = z.object({ planCode: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/) });

/**
 * POST /api/billing/checkout (FR-012, design §5.6)
 * Opens a payment for a plan or a credit pack and returns the Moyasar form options.
 * The price comes from the plans table (with the charity discount, FR-012c), never
 * from the browser. Subscriptions save the card for monthly renewal.
 */
export const POST = route(async (req) => {
  const { user } = await requireUser();
  const body = await parseBody(req, Body);
  const admin = adminClient();

  const { data: plan } = await admin
    .from("plans")
    .select("id, code, name_ar, name_en, billing_interval, is_active")
    .eq("code", body.planCode)
    .maybeSingle();
  if (!plan || !plan.is_active) throw new HttpError(404, "plan_not_found", "Plan not found");

  const { data: amount, error: priceErr } = await admin.rpc("plan_price_for", { p_user_id: user.id, p_plan_id: plan.id });
  if (priceErr) throw priceErr;
  if (!amount || (amount as number) < 100) throw new HttpError(400, "nothing_to_pay", "This plan is free");

  const isSubscription = plan.billing_interval !== null;
  // CR-004: an extra published app rides on a live paid plan and renews with it
  const isAddon = plan.code === "extra_app";
  if (isAddon && !(await hasPaidPlan(admin, user.id))) {
    throw new HttpError(402, "plan_required", "Extra apps need a paid plan");
  }
  const { data: payment, error } = await admin
    .from("payments")
    .insert({
      user_id: user.id,
      purpose: isAddon ? "extra_app" : isSubscription ? "subscription" : "credits",
      plan_id: plan.id,
      amount_halalas: amount as number,
      metadata: { plan: plan.code },
    })
    .select("id")
    .single();
  if (error) throw error;

  return json({
    paymentId: payment.id,
    form: checkoutConfig({
      paymentId: payment.id as string,
      amount: amount as number,
      description: `Banna ${plan.name_en}`,
      saveCard: isSubscription,
    }),
  });
});
