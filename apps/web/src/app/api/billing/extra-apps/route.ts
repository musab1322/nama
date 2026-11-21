import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

/**
 * DELETE /api/billing/extra-apps (CR-004): stops one extra published app from the next
 * renewal. Not refunded. Refused while every slot is in use; archive an app first.
 */
export const DELETE = route(async () => {
  const { user } = await requireUser();
  const { data, error } = await adminClient().rpc("remove_extra_app", { p_user_id: user.id });
  if (error) {
    if (error.message.includes("apps_over_limit")) {
      throw new HttpError(409, "apps_over_limit", "All your published apps are in use; archive one first");
    }
    if (error.message.includes("no_extra_app")) throw new HttpError(409, "no_extra_app", "No extra app to remove");
    throw error;
  }
  return json({ extraApps: data as number });
});
