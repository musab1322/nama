import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { enqueueJob } from "@banna/shared/jobs";
import { HttpError, json, route } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GET /api/cron/billing (Vercel Cron, daily). Queues renewals, ends canceled and
 * lapsed subscriptions, and queues suspension of lapsed owners' app backends.
 */
export const GET = route(async (req) => {
  if (req.headers.get("authorization") !== `Bearer ${env().CRON_SECRET}`) {
    throw new HttpError(401, "unauthorized", "Bad cron secret");
  }
  const admin = adminClient();

  const { data: ended, error: endErr } = await admin.rpc("end_canceled_subscriptions");
  if (endErr) throw endErr;

  const { data: lapsed, error: lapseErr } = await admin.rpc("expire_lapsed_subscriptions");
  if (lapseErr) throw lapseErr;
  let suspended = 0;
  for (const row of (lapsed ?? []) as { user_id: string }[]) {
    const { data: backends } = await admin
      .from("app_backends")
      .select("id, project_id, projects!inner(owner_id)")
      .eq("projects.owner_id", row.user_id)
      .eq("status", "active");
    for (const b of backends ?? []) {
      await enqueueJob(admin, "backend.suspend", { appBackendId: b.id, reason: "subscription_expired" }, {
        projectId: b.project_id as string,
        dedupeKey: `backend.suspend:${b.id}`,
      });
      suspended++;
    }
  }

  const { data: due, error: dueErr } = await admin.rpc("due_renewals", { p_limit: 200 });
  if (dueErr) throw dueErr;
  for (const r of (due ?? []) as { subscription_id: string }[]) {
    await enqueueJob(admin, "billing.renew", { subscriptionId: r.subscription_id }, {
      dedupeKey: `billing.renew:${r.subscription_id}`,
      maxAttempts: 3,
    });
  }

  return json({ ended, lapsed: (lapsed ?? []).length, suspended, renewalsQueued: (due ?? []).length });
});
