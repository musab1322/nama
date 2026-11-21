import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { hasPaidPlan } from "@banna/backends/ensure";
import { json, parseBody, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { mapAdminRpcError } from "@/lib/admin-errors";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(3).max(500) });
const ctxId = async (ctx: { params: Promise<{ id: string }> }) => z.string().uuid().parse((await ctx.params).id);

/**
 * POST /api/admin/projects/{id}/suspend (FR-013): stops the app's backend and blocks
 * publishing. Data is kept. Paying the plan does not lift it; only an admin does.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const id = await ctxId(ctx);
  const body = await parseBody(req, Body);
  const { data, error } = await adminClient().rpc("admin_suspend_project", { p_project_id: id, p_admin_id: user.id, p_reason: body.reason });
  if (error) mapAdminRpcError(error);
  return json({ id, result: data });
});

/** DELETE /api/admin/projects/{id}/suspend: lifts it; the backend restarts only while the owner's plan is paid. */
export const DELETE = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const id = await ctxId(ctx);
  const note = new URL(req.url).searchParams.get("note")?.slice(0, 500) ?? null;
  const admin = adminClient();
  const { data: project, error: pErr } = await admin.from("projects").select("owner_id").eq("id", id).maybeSingle();
  if (pErr) throw pErr;
  const resume = project ? await hasPaidPlan(admin, project.owner_id as string) : false;
  const { data, error } = await admin.rpc("admin_unsuspend_project", { p_project_id: id, p_admin_id: user.id, p_note: note, p_resume: resume });
  if (error) mapAdminRpcError(error);
  return json({ id, result: data });
});
