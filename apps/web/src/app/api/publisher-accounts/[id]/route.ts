import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({
  /** The owner confirms Google granted production access after the closed test (FR-006b). */
  playProductionAccess: z.literal(true),
});

/** PATCH /api/publisher-accounts/{id} */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const { supabase } = await requireUser();
  const id = z.string().uuid().parse((await params).id);
  const body = await parseBody(req, Patch);

  const { data: pub } = await supabase.from("publisher_accounts").select("id, platform").eq("id", id).maybeSingle();
  if (!pub) throw new HttpError(404, "publisher_not_found", "Account not found");
  if (pub.platform !== "android") throw new HttpError(400, "not_android", "Only Google Play accounts have this setting");

  const { data, error } = await adminClient()
    .from("publisher_accounts")
    .update({ play_production_access: body.playProductionAccess })
    .eq("id", id)
    .select("id, play_production_access")
    .single();
  if (error) throw error;
  return json({ publisher: data });
});

/** DELETE /api/publisher-accounts/{id}: disconnects the account and destroys the stored key. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { supabase } = await requireUser();
  const id = z.string().uuid().parse((await params).id);
  const { data: pub } = await supabase.from("publisher_accounts").select("id").eq("id", id).maybeSingle();
  if (!pub) throw new HttpError(404, "publisher_not_found", "Account not found");

  const admin = adminClient();
  const { data: row, error } = await admin
    .from("publisher_accounts")
    .update({ status: "revoked" })
    .eq("id", id)
    .select("credentials_secret_id")
    .single();
  if (error) throw error;
  if (row.credentials_secret_id) {
    await admin.rpc("vault_delete_secret", { p_secret_id: row.credentials_secret_id });
    await admin.from("publisher_accounts").update({ credentials_secret_id: null }).eq("id", id);
  }
  return json({ ok: true });
});
