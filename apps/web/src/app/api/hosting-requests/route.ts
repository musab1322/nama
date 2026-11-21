import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { hasPaidPlan } from "@banna/backends/ensure";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { HOSTING_COLUMNS, mapHostingRpcError } from "@/lib/hosting";

export const runtime = "nodejs";

const Body = z.object({ projectId: z.string().uuid(), region: z.literal("sa").default("sa") });

/** GET /api/hosting-requests?projectId=: the app's in-Kingdom hosting requests (newest first). */
export const GET = route(async (req) => {
  const { supabase } = await requireUser();
  const projectId = z.string().uuid().parse(new URL(req.url).searchParams.get("projectId"));
  await requireOwnedProject(supabase, projectId);
  const { data, error } = await supabase
    .from("hosting_requests")
    .select(HOSTING_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return json({ requests: data ?? [] });
});

/**
 * POST /api/hosting-requests (FR-017, design §5.2): asks for in-Kingdom hosting of the
 * app's data. Our team replies with a quote (setup + monthly fee; the first request
 * ever also sets up the cell, which takes business days). Nothing is charged here.
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  if (project.owner_id !== user.id) throw new HttpError(403, "forbidden", "Only the owner can change hosting");
  const admin = adminClient();
  if (!(await hasPaidPlan(admin, user.id))) throw new HttpError(402, "plan_required", "In-Kingdom hosting needs a paid plan");

  const { data: id, error } = await admin.rpc("request_saudi_hosting", { p_project_id: project.id, p_user_id: user.id });
  if (error) mapHostingRpcError(error);
  const { data: request, error: readError } = await admin.from("hosting_requests").select(HOSTING_COLUMNS).eq("id", id as string).single();
  if (readError) throw readError;
  return json({ request }, 201);
});
