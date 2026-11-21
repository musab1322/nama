import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { providerFor } from "@banna/backends/registry";
import type { HostingMode } from "@banna/backends/provider";
import { HttpError, json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * GET /api/admin/projects/{id}/stats: the app backend's size and active users (aggregates
 * only, never rows), plus what the app cost and earned on the platform side.
 */
export const GET = route(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  await requireAdmin();
  const id = z.string().uuid().parse((await ctx.params).id);
  const admin = adminClient();
  const { data: backend } = await admin
    .from("app_backends")
    .select("hosting, status, supabase_project_ref, cell_app_id")
    .eq("project_id", id)
    .maybeSingle();

  let backendStats = null;
  if (backend?.status === "active") {
    const ref = (backend.hosting === "standard" ? backend.supabase_project_ref : backend.cell_app_id) as string | null;
    if (!ref) throw new HttpError(409, "backend_unavailable", "Backend has no reference");
    backendStats = await providerFor(backend.hosting as HostingMode).stats(ref);
  }

  const { data: versions, error } = await admin.from("project_versions").select("credits_charged").eq("project_id", id);
  if (error) throw error;
  const creditsUsed = (versions ?? []).reduce((n, v) => n + ((v.credits_charged as number | null) ?? 0), 0);
  return json({ backend: backend ? { hosting: backend.hosting, status: backend.status } : null, backendStats, creditsUsed });
});
