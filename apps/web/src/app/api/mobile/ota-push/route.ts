import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { enqueueJob } from "@banna/shared/jobs";
import { moderateForStore } from "@banna/generator/moderation";
import { deployWeb } from "@banna/integrations/deploy-web";
import { loadVersionFiles } from "@banna/shared/snapshots";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  projectId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  message: z.string().trim().max(500).optional(),
  rolloutPercentage: z.number().int().min(1).max(100).default(100),
  alsoDeployWeb: z.boolean().default(true),
});

interface LiveBuild {
  id: string;
  platform: "ios" | "android";
  runtime_version: string;
  native_fingerprint: string | null;
}

/**
 * POST /api/mobile/ota-push — "Update app" button.
 * Ships the version to installed apps over the air when the native layer is
 * unchanged. Otherwise answers 409 native_rebuild_required (new store review).
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const versionId = body.versionId ?? project.current_version_id;
  if (!versionId) throw new HttpError(409, "nothing_to_update", "Generate the app first");
  const admin = adminClient();

  const { version, files } = await loadVersionFiles(admin, versionId);
  if (version.project_id !== project.id) throw new HttpError(404, "version_not_found", "Version not found");

  // The binary that store users actually have = latest build whose submission is live.
  const { data: rows, error } = await admin
    .from("mobile_builds")
    .select("id, platform, runtime_version, native_fingerprint, build_number, store_submissions!inner(status)")
    .eq("project_id", project.id)
    .eq("status", "finished")
    .in("store_submissions.status", ["approved", "published"])
    .order("build_number", { ascending: false });
  if (error) throw error;

  const live = new Map<string, LiveBuild>();
  for (const r of rows ?? []) if (!live.has(r.platform as string)) live.set(r.platform as string, r as LiveBuild);
  if (live.size === 0) {
    throw new HttpError(409, "no_published_app", "Publish the app to the stores first; updates apply after approval");
  }

  const mismatched = [...live.values()].filter((b) => b.native_fingerprint !== version.native_fingerprint);
  if (mismatched.length) {
    throw new HttpError(409, "native_rebuild_required", "This change needs a new store release", {
      platforms: mismatched.map((b) => b.platform),
    });
  }

  // Same review as store submissions: OTA must not change the app's primary purpose (Apple 2.5.2 / 3.3.1(B)).
  const { data: app } = await admin
    .from("mobile_apps")
    .select("display_name, full_description")
    .eq("project_id", project.id)
    .eq("listing_status", "live")
    .limit(1)
    .maybeSingle();
  const verdict = await moderateForStore({
    kind: "ota_update",
    appName: (app?.display_name as string) ?? project.name,
    description: (app?.full_description as string) ?? "",
    approvedDescription: (app?.full_description as string) ?? null,
    screensSummary: Object.keys(files).filter((p) => p.startsWith("app/") || p.startsWith("components/")).join("\n"),
  });
  if (!verdict.allowed) throw new HttpError(422, "store_policy_violation", "This update can't be shipped", verdict);

  // One release per runtime (iOS and Android may resolve to different fingerprints).
  const byRuntime = new Map<string, ("ios" | "android")[]>();
  for (const b of live.values()) byRuntime.set(b.runtime_version, [...(byRuntime.get(b.runtime_version) ?? []), b.platform]);

  const releases = [];
  for (const [runtimeVersion, platforms] of byRuntime) {
    const { data: rel, error: relErr } = await admin
      .from("ota_releases")
      .insert({
        project_id: project.id,
        version_id: versionId,
        provider: "eas_update",
        channel: "production",
        runtime_version: runtimeVersion,
        platforms,
        rollout_percentage: body.rolloutPercentage,
        is_rollback: versionId !== project.current_version_id,
        message: body.message ?? `v${version.version_number}`,
        triggered_by: user.id,
      })
      .select("id, platforms, runtime_version, status")
      .single();
    if (relErr) throw relErr;
    releases.push(rel);
    await enqueueJob(admin, "mobile.ota", { releaseId: rel.id }, { projectId: project.id, dedupeKey: `ota:${rel.id}` });
  }

  let web = null;
  if (body.alsoDeployWeb) {
    try {
      web = await deployWeb(admin, project, { versionId, target: "production", userId: user.id });
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "deployment_in_progress")) throw err;
    }
  }
  return json({ releases, web }, 202);
});
