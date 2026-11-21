import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { deployWeb } from "@banna/integrations/deploy-web";
import { claimPublishSlot, ensureBackend, hasPaidPlan } from "@banna/backends/ensure";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid().optional(), // defaults to current version; any older version = rollback deploy
  target: z.enum(["production", "preview"]).default("production"),
});

/**
 * POST /api/deploy/web
 * Uploads the version to Vercel and starts the build. Returns 202 immediately;
 * on the first paid publish it provisions the backend first and deploys afterwards;
 * the Vercel webhook flips the row to ready/error and Realtime updates the UI.
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const versionId = body.versionId ?? project.current_version_id;
  if (!versionId) throw new HttpError(409, "nothing_to_deploy", "Generate the app first");

  // RLS check that the version belongs to this user's project.
  const { data: version } = await supabase
    .from("project_versions")
    .select("id")
    .eq("id", versionId)
    .eq("project_id", project.id)
    .maybeSingle();
  if (!version) throw new HttpError(404, "version_not_found", "Version not found");

  const admin = adminClient();
  const followUp = { kind: "deploy.web" as const, versionId, target: body.target, userId: user.id };

  // Previews are free (FR-012a, ADR-010): the database runs inside the visitor's browser, no backend.
  if (body.target === "preview") {
    const { data: state } = await admin.from("projects").select("suspended_at").eq("id", project.id).single();
    if (state?.suspended_at) throw new HttpError(423, "project_suspended", "This app is suspended by the platform; contact support");
    const deployment = await deployWeb(admin, project, followUp);
    return json({ deployment, backend: { status: "not_needed" } }, 202);
  }

  // Publishing is paid (FR-012a); the backend is created now if this is the first paid publish (NFR-007).
  if (!(await hasPaidPlan(admin, project.owner_id))) throw new HttpError(402, "plan_required", "Publishing needs a paid plan");
  await claimPublishSlot(admin, project.id, project.owner_id);
  const backend = await ensureBackend(admin, project, { followUp });
  if (backend.state === "provisioning") {
    // the worker deploys by itself once the database is ready (1-3 minutes)
    return json({ deployment: null, backend: { status: "provisioning", jobId: backend.jobId } }, 202);
  }

  const deployment = await deployWeb(admin, project, followUp);
  return json({ deployment, backend: { status: backend.state } }, 202);
});
