import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { enqueueJob } from "@banna/shared/jobs";
import { hasPlanFeature } from "@banna/backends/ensure";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ projectId: z.string().uuid(), versionId: z.string().uuid().optional() });

/** POST /api/exports (FR-016): queues a zip of the app's code (top plan only). */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const versionId = body.versionId ?? project.current_version_id;
  if (!versionId) throw new HttpError(409, "nothing_to_export", "Generate the app first");

  const admin = adminClient();
  if (!(await hasPlanFeature(admin, user.id, "code_export"))) {
    throw new HttpError(402, "plan_required", "Code export is part of the Pro plan");
  }
  const { data: version } = await supabase.from("project_versions").select("id").eq("id", versionId).eq("project_id", project.id).maybeSingle();
  if (!version) throw new HttpError(404, "version_not_found", "Version not found");

  const { data: row, error } = await admin
    .from("code_exports")
    .insert({ project_id: project.id, version_id: versionId, requested_by: user.id })
    .select("id, status, created_at")
    .single();
  if (error) throw error;
  await enqueueJob(admin, "code.export", { exportId: row.id }, { projectId: project.id, dedupeKey: `code.export:${row.id}` });
  return json({ export: row }, 202);
});
