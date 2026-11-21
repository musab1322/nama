import { adminClient } from "@banna/shared/supabase-admin";
import { saudiCellConfigured } from "@banna/backends/registry";
import { env } from "@banna/shared/env";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { HOSTING_COLUMNS } from "@/lib/hosting";

export const runtime = "nodejs";

const STATUSES = ["requested", "quoted", "paid", "provisioning", "migrating", "active", "canceled"] as const;

/**
 * GET /api/admin/hosting-requests?status=requested: requests to quote, or paid ones to fulfil.
 * needsMigration: the app already has a standard backend, so its data must be moved (infra/cell/README.md).
 */
export const GET = route(async (req) => {
  await requireAdmin();
  const param = new URL(req.url).searchParams.get("status");
  const status = STATUSES.find((s) => s === param) ?? "requested";
  const admin = adminClient();
  const { data, error } = await admin
    .from("hosting_requests")
    .select(`${HOSTING_COLUMNS}, projects(name, slug, owner_id, app_backends(hosting, status))`)
    .eq("status", status)
    .order("updated_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  type Row = { projects: { app_backends: { hosting: string; status: string } | { hosting: string; status: string }[] | null } | null };
  const requests = ((data ?? []) as unknown as Row[]).map((r) => {
    const b = r.projects?.app_backends;
    const backend = Array.isArray(b) ? (b[0] ?? null) : b;
    return { ...r, needsMigration: backend?.hosting === "standard" };
  });
  return json({ requests, cellConfigured: saudiCellConfigured(env()) });
});
