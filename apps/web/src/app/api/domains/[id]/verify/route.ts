import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";
import { refreshDomain } from "@banna/integrations/domains";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/domains/:id/verify — the "Verify now" button. */
export const POST = route<Ctx>(async (_req, ctx) => {
  const { supabase } = await requireUser();
  const id = z.string().uuid().parse((await ctx.params).id);
  const { data: domain } = await supabase
    .from("domains")
    .select("id, hostname, status, last_checked_at, projects!inner(vercel_project_id)")
    .eq("id", id)
    .maybeSingle();
  if (!domain || domain.status === "removed") throw new HttpError(404, "domain_not_found", "Domain not found");

  // Light rate limit: one manual check every 10 seconds per domain.
  if (domain.last_checked_at && Date.now() - Date.parse(domain.last_checked_at as string) < 10_000) {
    throw new HttpError(429, "too_soon", "Please wait a few seconds before checking again");
  }
  const vercelProjectId = (domain.projects as unknown as { vercel_project_id: string }).vercel_project_id;
  const updated = await refreshDomain(adminClient(), {
    id: domain.id as string,
    hostname: domain.hostname as string,
    vercel_project_id: vercelProjectId,
  });
  return json({ domain: updated });
});
