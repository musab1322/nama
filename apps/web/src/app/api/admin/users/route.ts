import { adminClient } from "@banna/shared/supabase-admin";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { searchTerm } from "@/lib/admin-errors";

export const runtime = "nodejs";

/** GET /api/admin/users?q=: platform customers (not app end users), with plan, credits and app count. */
export const GET = route(async (req) => {
  await requireAdmin();
  const q = searchTerm(new URL(req.url).searchParams.get("q"));
  let query = adminClient()
    .from("profiles")
    .select(
      "id, email, full_name, role, locale, credits_balance, created_at, " +
        "subscriptions(status, plan, current_period_end, grace_until, cancel_at_period_end), projects(count), organizations!organizations_owner_id_fkey(kind, verification_status)",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (q) query = query.or(`email.ilike.*${q}*,full_name.ilike.*${q}*`);
  const { data, error } = await query;
  if (error) throw error;
  return json({ users: data ?? [] });
});
