import { adminClient } from "@banna/shared/supabase-admin";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";

const STATUSES = ["open", "reviewing", "actioned", "dismissed"] as const;

/** GET /api/admin/reports?status=open: content reports about generated apps (FR-013). */
export const GET = route(async (req) => {
  await requireAdmin();
  const param = new URL(req.url).searchParams.get("status");
  const status = STATUSES.find((s) => s === param) ?? "open";
  const { data, error } = await adminClient()
    .from("reports")
    .select("id, reason, details, reporter_email, status, created_at, handled_at, projects(id, name, slug, suspended_at)")
    .eq("status", status)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return json({ reports: data ?? [] });
});
