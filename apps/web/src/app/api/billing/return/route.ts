import { NextResponse } from "next/server";
import { env } from "@banna/shared/env";
import { adminClient } from "@banna/shared/supabase-admin";
import { settleFromMoyasar } from "@banna/integrations/billing";

export const runtime = "nodejs";

/**
 * GET /api/billing/return?payment=<our id>&id=<moyasar id>&status=…
 * Moyasar sends the payer back here. The query is only a hint: the result is
 * read from Moyasar's API before anything is granted.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ours = url.searchParams.get("payment");
  const moyasarId = url.searchParams.get("id");
  const back = new URL("/billing", env().PLATFORM_APP_URL);
  if (!moyasarId || !/^[\w-]{8,64}$/.test(moyasarId)) {
    back.searchParams.set("status", "failed");
    return NextResponse.redirect(back, 303);
  }
  try {
    const r = await settleFromMoyasar(adminClient(), moyasarId, { expectedPaymentId: ours ?? undefined });
    const ok = ["subscription_active", "credits_added", "hosting_paid", "extra_app_added", "paid", "already_settled"].includes(r.outcome);
    back.searchParams.set("status", ok ? "paid" : r.moyasarStatus === "initiated" ? "pending" : "failed");
  } catch (err) {
    console.error("[billing] return failed", err);
    back.searchParams.set("status", "pending"); // the webhook settles it later
  }
  return NextResponse.redirect(back, 303);
}
