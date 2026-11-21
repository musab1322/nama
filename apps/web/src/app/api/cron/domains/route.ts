import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { HttpError, json, route } from "@/lib/http";
import { refreshDomain } from "@banna/integrations/domains";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/domains — Vercel Cron (every 5 minutes, see vercel.ts).
 * Re-checks pending domains with backoff: every 5 min for the first hour,
 * then hourly; gives up after 7 days.
 */
export const GET = route(async (req) => {
  if (req.headers.get("authorization") !== `Bearer ${env().CRON_SECRET}`) {
    throw new HttpError(401, "unauthorized", "Bad cron secret");
  }
  const admin = adminClient();
  const { data: rows, error } = await admin
    .from("domains")
    .select("id, hostname, created_at, last_checked_at, projects!inner(vercel_project_id)")
    .in("status", ["pending", "verifying", "misconfigured"])
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(50);
  if (error) throw error;

  const now = Date.now();
  let checked = 0;
  for (const row of rows ?? []) {
    const age = now - Date.parse(row.created_at as string);
    const since = row.last_checked_at ? now - Date.parse(row.last_checked_at as string) : Infinity;
    if (age > 7 * 864e5) {
      await admin
        .from("domains")
        .update({ status: "error", misconfigured_reason: "DNS was not configured within 7 days" })
        .eq("id", row.id);
      continue;
    }
    const interval = age < 36e5 ? 5 * 6e4 : 36e5;
    if (since < interval) continue;
    const vercelProjectId = (row.projects as unknown as { vercel_project_id: string | null }).vercel_project_id;
    if (!vercelProjectId) continue;
    try {
      await refreshDomain(admin, { id: row.id as string, hostname: row.hostname as string, vercel_project_id: vercelProjectId });
      checked++;
    } catch (err) {
      console.error("[cron/domains]", row.hostname, err);
    }
  }
  return json({ checked });
});
