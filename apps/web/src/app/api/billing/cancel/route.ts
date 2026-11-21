import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

/** POST /api/billing/cancel: stops renewal; the paid period runs to its end. */
export const POST = route(async () => {
  const { user } = await requireUser();
  const { data, error } = await adminClient()
    .from("subscriptions")
    .update({ cancel_at_period_end: true })
    .eq("user_id", user.id)
    .in("status", ["active", "trialing"])
    .select("id, current_period_end");
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, "no_subscription", "No active subscription");
  return json({ endsAt: data[0]!.current_period_end });
});
