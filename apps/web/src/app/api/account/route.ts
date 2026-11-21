import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ confirmEmail: z.string().email() });

/**
 * DELETE /api/account (UC-13, design §5.9): schedules deletion of the platform account.
 * Billing stops now; in 7 days every app backend, web project, file and key is deleted,
 * then the account itself. Apps on the customer's own store accounts stay theirs but stop working.
 */
export const DELETE = route(async (req) => {
  const { user } = await requireUser();
  const body = await parseBody(req, Body);
  if (body.confirmEmail.trim().toLowerCase() !== (user.email ?? "").toLowerCase()) {
    throw new HttpError(400, "confirmation_mismatch", "Type your account email to confirm");
  }
  const { data, error } = await adminClient().rpc("request_account_deletion", { p_user_id: user.id });
  if (error) throw error;
  return json({ scheduledFor: data as string }, 202);
});

/** PATCH /api/account: cancels a scheduled deletion during the 7 days. Renewal stays off; subscribe again from Plans. */
export const PATCH = route(async () => {
  const { user } = await requireUser();
  const { error } = await adminClient().rpc("cancel_account_deletion", { p_user_id: user.id });
  if (error) {
    if (error.message?.includes("not_cancelable")) throw new HttpError(409, "not_cancelable", "No deletion to cancel");
    throw error;
  }
  return json({ canceled: true });
});
