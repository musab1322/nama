import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";
import { removeProjectDomain, VercelError } from "@banna/integrations/vercel";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/domains/:id — detach from Vercel and mark removed (keeps history). */
export const DELETE = route<Ctx>(async (_req, ctx) => {
  const { supabase } = await requireUser();
  const id = z.string().uuid().parse((await ctx.params).id);
  const { data: domain } = await supabase
    .from("domains")
    .select("id, hostname, status, projects!inner(vercel_project_id)")
    .eq("id", id)
    .maybeSingle();
  if (!domain || domain.status === "removed") throw new HttpError(404, "domain_not_found", "Domain not found");

  const vercelProjectId = (domain.projects as unknown as { vercel_project_id: string | null }).vercel_project_id;
  if (vercelProjectId) {
    try {
      await removeProjectDomain(vercelProjectId, domain.hostname as string);
    } catch (err) {
      if (!(err instanceof VercelError && err.status === 404)) throw err;
    }
  }
  const { error } = await adminClient().from("domains").update({ status: "removed" }).eq("id", id);
  if (error) throw error;
  return json({ ok: true });
});
