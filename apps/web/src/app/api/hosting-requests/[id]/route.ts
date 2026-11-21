import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, requireUser, route } from "@/lib/http";
import { mapHostingRpcError } from "@/lib/hosting";

export const runtime = "nodejs";

/** DELETE /api/hosting-requests/{id}: cancels a request that is not paid yet. */
export const DELETE = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireUser();
  const id = z.string().uuid().parse((await ctx.params).id);
  const { error } = await adminClient().rpc("cancel_hosting_request", { p_request_id: id, p_user_id: user.id });
  if (error) mapHostingRpcError(error);
  return json({ id, status: "canceled" });
});
