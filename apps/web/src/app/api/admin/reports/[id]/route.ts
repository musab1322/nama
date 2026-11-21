import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, parseBody, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { mapAdminRpcError } from "@/lib/admin-errors";

export const runtime = "nodejs";

const Body = z.object({ status: z.enum(["reviewing", "actioned", "dismissed"]), note: z.string().trim().max(500).optional() });

/** PATCH /api/admin/reports/{id}: moves a report on. Suspending the app is a separate, explicit action. */
export const PATCH = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const id = z.string().uuid().parse((await ctx.params).id);
  const body = await parseBody(req, Body);
  const { error } = await adminClient().rpc("admin_handle_report", {
    p_report_id: id,
    p_admin_id: user.id,
    p_status: body.status,
    p_note: body.note ?? null,
  });
  if (error) mapAdminRpcError(error);
  return json({ id, status: body.status });
});
