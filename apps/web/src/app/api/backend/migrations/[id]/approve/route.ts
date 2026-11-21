import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireUser, route } from "@/lib/http";
import { enqueueJob } from "@banna/shared/jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ confirm: z.literal("DELETE_DATA") });

/**
 * POST /api/backend/migrations/:id/approve
 * A destructive AI migration (DROP / TRUNCATE / DELETE without WHERE) touches
 * the app's live data, so it waits until the owner explicitly confirms it.
 */
export const POST = route<Ctx>(async (req, ctx) => {
  const { supabase } = await requireUser();
  await parseBody(req, Body);
  const id = z.string().uuid().parse((await ctx.params).id);

  const { data: m } = await supabase
    .from("backend_migrations")
    .select("id, status, project_id, app_backend_id")
    .eq("id", id)
    .maybeSingle(); // RLS: only the project owner sees it
  if (!m) throw new HttpError(404, "migration_not_found", "Not found");
  if (m.status !== "blocked") throw new HttpError(409, "not_blocked", "This change does not need approval");

  const admin = adminClient();
  const { error } = await admin.from("backend_migrations").update({ status: "pending" }).eq("id", id).eq("status", "blocked");
  if (error) throw error;
  await enqueueJob(admin, "backend.apply_migrations", { appBackendId: m.app_backend_id }, {
    projectId: m.project_id as string,
    dedupeKey: `backend.migrate:${m.project_id}`,
  });
  return json({ ok: true });
});
