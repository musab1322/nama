import { adminClient } from "@banna/shared/supabase-admin";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { searchTerm } from "@/lib/admin-errors";

export const runtime = "nodejs";

/**
 * GET /api/admin/projects?q=&suspended=1: apps with their owner, hosting, backend and
 * publishing state, latest deployment and open reports. No end-user data.
 */
export const GET = route(async (req) => {
  await requireAdmin();
  const params = new URL(req.url).searchParams;
  const q = searchTerm(params.get("q"));
  let query = adminClient()
    .from("projects")
    .select(
      "id, name, slug, status, category, created_at, updated_at, suspended_at, suspension_reason, " +
        "profiles!projects_owner_id_fkey(email), app_backends(hosting, status, last_error, provisioned_at), " +
        "mobile_apps(platform, listing_status, store_url), reports(count)",
    )
    .order("updated_at", { ascending: false })
    .limit(50);
  if (q) query = query.or(`name.ilike.*${q}*,slug.ilike.*${q}*`);
  if (params.get("suspended") === "1") query = query.not("suspended_at", "is", null);
  const { data, error } = await query;
  if (error) throw error;
  return json({ projects: data ?? [] });
});
