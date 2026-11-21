import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, isUniqueViolation, json, parseBody, requireUser, route } from "@/lib/http";
import { playAccessToken } from "@banna/integrations/google-play";

export const runtime = "nodejs";

const ServiceAccount = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email().endsWith(".iam.gserviceaccount.com"),
  private_key: z.string().includes("BEGIN PRIVATE KEY"),
  token_uri: z.string().url().optional(),
});

const Body = z.object({
  displayName: z.string().trim().min(1).max(120), // developer name shown on Google Play
  developerId: z.string().regex(/^\d{5,25}$/, "The developer ID is the number in your Play Console URL"),
  accountType: z.enum(["personal", "organization"]),
  /** When the Play developer account was created; decides the closed-testing rule. */
  accountCreatedOn: z.string().date().optional(),
  serviceAccountJson: z.string().max(10000),
});

/**
 * POST /api/publisher-accounts/google (FR-006a)
 * The customer connects THEIR Google Play developer account with a service-account
 * JSON key (Play Console role: Release manager). The key goes straight into Vault.
 * Google confirms the key now; the Play permission is confirmed at the first release.
 */
export const POST = route(async (req) => {
  const { user } = await requireUser();
  const body = await parseBody(req, Body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.serviceAccountJson);
  } catch {
    throw new HttpError(422, "google_key_invalid", "Upload the JSON key file exactly as Google Cloud downloaded it");
  }
  const sa = ServiceAccount.safeParse(parsed);
  if (!sa.success) throw new HttpError(422, "google_key_invalid", "This is not a service-account key file", sa.error.issues);

  try {
    await playAccessToken(body.serviceAccountJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/invalid_grant|invalid_client|unauthorized|disabled|not found/i.test(message) || /key|asn1|decoder/i.test(message)) {
      throw new HttpError(422, "google_key_rejected", "Google rejected this key. Create a new key for the service account and try again.");
    }
    throw err;
  }

  const admin = adminClient();
  const { data: secretId, error: vaultError } = await admin.rpc("vault_store_secret", {
    p_secret: body.serviceAccountJson,
    p_name: `play:${user.id}:${body.developerId}:${randomUUID()}`,
    p_description: `Google Play service account ${sa.data.client_email}`,
  });
  if (vaultError) throw vaultError;

  const { data, error } = await admin
    .from("publisher_accounts")
    .insert({
      kind: "customer",
      owner_id: user.id,
      platform: "android",
      display_name: body.displayName,
      play_developer_id: body.developerId,
      play_account_type: body.accountType,
      play_account_created_on: body.accountCreatedOn ?? null,
      credentials_secret_id: secretId,
      status: "verified",
      verified_at: new Date().toISOString(),
    })
    .select("id, display_name, play_developer_id, play_account_type, play_account_created_on, play_production_access, status, verified_at")
    .single();
  if (error) {
    await admin.rpc("vault_delete_secret", { p_secret_id: secretId });
    if (isUniqueViolation(error)) throw new HttpError(409, "already_connected", "This Google Play account is already connected");
    throw error;
  }

  const { data: needsClosedTest } = await admin.rpc("play_needs_closed_test", { p_publisher_id: data.id });
  return json({ publisher: data, needsClosedTest: !!needsClosedTest }, 201);
});
