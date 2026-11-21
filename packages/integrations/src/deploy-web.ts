import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";
import { HttpError, isUniqueViolation, type OwnedProject } from "@banna/shared/errors";
import { loadVersionFiles } from "@banna/shared/snapshots";
import { withPreviewConfig } from "./preview";
import { appPublicEnv } from "./app-env";
import { addProjectDomain, createDeployment, createProject, upsertEnv, VercelError } from "./vercel";

/** Ensures the Vercel project exists, with the default subdomain and the app's backend env vars. */
export async function ensureVercelProject(admin: SupabaseClient, project: OwnedProject): Promise<string> {
  let vercelProjectId = project.vercel_project_id;
  if (!vercelProjectId) {
    const created = await createProject(`app-${project.slug}`);
    vercelProjectId = created.id;
    const { error } = await admin
      .from("projects")
      .update({ vercel_project_id: vercelProjectId })
      .eq("id", project.id)
      .is("vercel_project_id", null);
    if (error) throw error;
    try {
      // Wildcard *.PLATFORM_ROOT_DOMAIN must be on the Vercel team (nameservers on Vercel).
      await addProjectDomain(vercelProjectId, `${project.slug}.${env().PLATFORM_ROOT_DOMAIN}`);
    } catch (err) {
      if (!(err instanceof VercelError && err.status === 409)) throw err;
    }
  }

  const publicEnv = await appPublicEnv(admin, project.id);
  await upsertEnv(vercelProjectId, Object.entries(publicEnv).map(([key, value]) => ({ key, value })));

  // Point the web build at the app's OWN Supabase project.
  const { data: backend } = await admin
    .from("app_backends")
    .select("api_url, publishable_key, status")
    .eq("project_id", project.id)
    .maybeSingle();
  if (backend?.status === "active" && backend.api_url && backend.publishable_key) {
    await upsertEnv(
      vercelProjectId,
      [
        { key: "EXPO_PUBLIC_SUPABASE_URL", value: backend.api_url },
        { key: "EXPO_PUBLIC_SUPABASE_KEY", value: backend.publishable_key },
      ],
      ["production"],
    );
  }
  return vercelProjectId;
}

export async function deployWeb(
  admin: SupabaseClient,
  project: OwnedProject,
  opts: { versionId: string; target: "production" | "preview"; userId: string },
) {
  const { data: row, error: insertError } = await admin
    .from("web_deployments")
    .insert({
      project_id: project.id,
      version_id: opts.versionId,
      target: opts.target,
      status: "queued",
      triggered_by: opts.userId,
    })
    .select("id")
    .single();
  if (insertError) {
    if (isUniqueViolation(insertError)) {
      throw new HttpError(409, "deployment_in_progress", "A deployment is already running for this project");
    }
    throw insertError;
  }

  try {
    const vercelProjectId = await ensureVercelProject(admin, project);
    const loaded = await loadVersionFiles(admin, opts.versionId);
    // previews run on the in-browser database; only production talks to the real backend
    const files = opts.target === "preview" ? withPreviewConfig(loaded.files) : loaded.files;
    const dep = await createDeployment({
      vercelProjectId,
      name: `app-${project.slug}`,
      files,
      target: opts.target,
      meta: { platformDeploymentId: row.id, platformProjectId: project.id, versionId: opts.versionId },
    });
    const { data, error } = await admin
      .from("web_deployments")
      .update({
        status: dep.readyState === "READY" ? "ready" : "building",
        vercel_deployment_id: dep.id,
        url: `https://${dep.url}`,
        alias_url: opts.target === "production" ? `https://${project.slug}.${env().PLATFORM_ROOT_DOMAIN}` : null,
        inspector_url: dep.inspectorUrl ?? null,
      })
      .eq("id", row.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (err) {
    await admin
      .from("web_deployments")
      .update({
        status: "error",
        error_code: err instanceof VercelError ? err.code : "deploy_failed",
        error_message: err instanceof Error ? err.message.slice(0, 1000) : "deploy failed",
      })
      .eq("id", row.id);
    throw err instanceof VercelError ? new HttpError(502, "vercel_error", err.message) : err;
  }
}
