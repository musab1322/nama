import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, parseBody, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { mapAdminRpcError } from "@/lib/admin-errors";

export const runtime = "nodejs";

const Body = z.object({ amount: z.number().int(), note: z.string().trim().min(1).max(300) });

/** POST /api/admin/users/{id}/credits: adds (or removes, if negative) credits, with a reason in the audit log. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const id = z.string().uuid().parse((await ctx.params).id);
  const body = await parseBody(req, Body);
  const { data, error } = await adminClient().rpc("admin_grant_credits", {
    p_user_id: id,
    p_admin_id: user.id,
    p_amount: body.amount,
    p_note: body.note,
  });
  if (error) mapAdminRpcError(error);
  return json({ id, creditsBalance: data as number });
});
