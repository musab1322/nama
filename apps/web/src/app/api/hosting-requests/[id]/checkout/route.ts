import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { checkoutConfig } from "@banna/integrations/moyasar";
import { json, requireUser, route } from "@/lib/http";
import { mapHostingRpcError } from "@/lib/hosting";

export const runtime = "nodejs";

/**
 * POST /api/hosting-requests/{id}/checkout: the Moyasar form for the quoted setup fee.
 * The amount comes from the quote in the database. Payment marks the request paid
 * (settle_platform_payment); the monthly fee is added to the plan renewal once hosting is active.
 */
export const POST = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireUser();
  const id = z.string().uuid().parse((await ctx.params).id);
  const { data, error } = await adminClient().rpc("open_hosting_payment", { p_request_id: id, p_user_id: user.id });
  if (error) mapHostingRpcError(error);
  const row = (data as { payment_id: string; amount: number }[])[0]!;
  return json({
    paymentId: row.payment_id,
    form: checkoutConfig({ paymentId: row.payment_id, amount: row.amount, description: "Banna in-Kingdom hosting setup", saveCard: false }),
  });
});
