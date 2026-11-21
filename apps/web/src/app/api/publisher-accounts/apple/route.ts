import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, isUniqueViolation, json, parseBody, requireUser, route } from "@/lib/http";
import { AscError, verifyCredentials } from "@banna/integrations/apple";

export const runtime = "nodejs";

const Body = z.object({
  displayName: z.string().trim().min(1).max(120), // seller name shown in the App Store
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  issuerId: z.string().uuid(),
  privateKey: z
    .string()
    .max(4000)
    .refine((k) => k.includes("BEGIN PRIVATE KEY") && k.includes("END PRIVATE KEY"), "Paste the full .p8 file"),
});

/**
 * POST /api/publisher-accounts/apple
 * The customer connects THEIR Apple Developer account by uploading an App Store
 * Connect API key (role: App Manager). The .p8 goes straight into Supabase Vault;
 * only its Vault id is stored, and users can never read that column.
 */
export const POST = route(async (req) => {
  const { user } = await requireUser();
  const body = await parseBody(req, Body);
  const creds = { keyId: body.keyId, issuerId: body.issuerId, privateKeyP8: body.privateKey.trim() };

  try {
    await verifyCredentials(creds);
  } catch (err) {
    if (err instanceof AscError && (err.status === 401 || err.status === 403)) {
      throw new HttpError(422, "apple_key_rejected", "Apple rejected this key. Check the Key ID, Issuer ID and role.");
    }
    if (err instanceof Error && /key|asn1|decoder/i.test(err.message)) {
      throw new HttpError(422, "apple_key_invalid", "The .p8 file could not be read");
    }
    throw err;
  }

  const admin = adminClient();
  const { data: secretId, error: vaultError } = await admin.rpc("vault_store_secret", {
    p_secret: creds.privateKeyP8,
    p_name: `asc:${user.id}:${body.keyId}:${randomUUID()}`,
    p_description: `App Store Connect API key for team ${body.teamId}`,
  });
  if (vaultError) throw vaultError;

  const { data, error } = await admin
    .from("publisher_accounts")
    .insert({
      kind: "customer",
      owner_id: user.id,
      platform: "ios",
      display_name: body.displayName,
      apple_team_id: body.teamId,
      asc_key_id: body.keyId,
      asc_issuer_id: body.issuerId,
      credentials_secret_id: secretId,
      status: "verified",
      verified_at: new Date().toISOString(),
    })
    .select("id, display_name, apple_team_id, asc_key_id, status, verified_at")
    .single();
  if (error) {
    await admin.rpc("vault_delete_secret", { p_secret_id: secretId });
    if (isUniqueViolation(error)) throw new HttpError(409, "already_connected", "This key is already connected");
    throw error;
  }
  return json({ publisher: data }, 201);
});
