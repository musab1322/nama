import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { saudiCellConfigured } from "@banna/backends/registry";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";

/** GET /api/admin/overview (FR-013): platform numbers and what needs attention. Aggregates only. */
export const GET = route(async () => {
  await requireAdmin();
  const { data, error } = await adminClient().rpc("admin_overview");
  if (error) throw error;
  return json({ overview: data, saudiCellConfigured: saudiCellConfigured(env()) });
});
