import { adminClient } from "@banna/shared/supabase-admin";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";

/** GET /api/admin/jobs: queue health. Payloads are left out (they can name keys and versions). */
export const GET = route(async () => {
  await requireAdmin();
  const admin = adminClient();
  const [failed, waiting] = await Promise.all([
    admin
      .from("jobs")
      .select("id, kind, project_id, status, attempts, max_attempts, last_error, updated_at")
      .in("status", ["failed", "dead"])
      .order("updated_at", { ascending: false })
      .limit(50),
    admin
      .from("jobs")
      .select("id, kind, project_id, status, attempts, run_after, created_at")
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: true })
      .limit(50),
  ]);
  if (failed.error) throw failed.error;
  if (waiting.error) throw waiting.error;
  return json({ failed: failed.data ?? [], waiting: waiting.data ?? [] });
});
