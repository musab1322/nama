import { timingSafeEqual } from "node:crypto";
import { env } from "@banna/shared/env";
import { adminClient } from "@banna/shared/supabase-admin";
import { settleFromMoyasar } from "@banna/integrations/billing";
import { HttpError, json, route } from "@/lib/http";

export const runtime = "nodejs";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * POST /api/webhooks/moyasar (design §8: spoofed webhooks)
 * The body is never trusted: we take the payment id from it and re-read the
 * payment from Moyasar with our secret key. Settling is idempotent.
 */
export const POST = route(async (req) => {
  const body = (await req.json().catch(() => null)) as { secret_token?: string; data?: { id?: string }; id?: string } | null;
  if (!body) throw new HttpError(400, "invalid_json", "Body must be JSON");

  const secret = env().MOYASAR_WEBHOOK_SECRET;
  if (secret && !(typeof body.secret_token === "string" && same(body.secret_token, secret))) {
    throw new HttpError(401, "bad_signature", "Unknown webhook sender");
  }
  const id = body.data?.id ?? body.id;
  if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id)) return json({ ignored: true });

  const r = await settleFromMoyasar(adminClient(), id);
  return json({ outcome: r.outcome });
});
