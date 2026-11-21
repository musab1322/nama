import type { SupabaseClient } from "@supabase/supabase-js";
import type { AscCredentials } from "./apple";

export interface PublisherRow {
  id: string;
  kind: "platform" | "customer";
  platform: "ios" | "android";
  apple_team_id: string | null;
  asc_key_id: string | null;
  asc_issuer_id: string | null;
  credentials_secret_id: string | null;
  status: string;
}

export async function readSecret(admin: SupabaseClient, secretId: string): Promise<string> {
  const { data, error } = await admin.rpc("vault_read_secret", { p_secret_id: secretId });
  if (error) throw error;
  if (!data) throw new Error("secret not found");
  return data as string;
}

export async function loadPublisher(admin: SupabaseClient, id: string): Promise<PublisherRow> {
  const { data, error } = await admin
    .from("publisher_accounts")
    .select("id, kind, platform, apple_team_id, asc_key_id, asc_issuer_id, credentials_secret_id, status")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as PublisherRow;
}

export async function ascCredentialsFor(admin: SupabaseClient, pub: PublisherRow): Promise<AscCredentials> {
  if (pub.platform !== "ios" || !pub.asc_key_id || !pub.asc_issuer_id || !pub.credentials_secret_id) {
    throw new Error("not an App Store Connect publisher");
  }
  return {
    keyId: pub.asc_key_id,
    issuerId: pub.asc_issuer_id,
    privateKeyP8: await readSecret(admin, pub.credentials_secret_id),
  };
}

/**
 * Android publisher: the customer's own Play account if connected, otherwise the
 * platform account (its service-account JSON lives in Vault; see publisher_accounts kind='platform').
 */
export async function playCredentialsFor(admin: SupabaseClient, pub: PublisherRow): Promise<string> {
  if (pub.platform !== "android" || !pub.credentials_secret_id) throw new Error("not a Play publisher");
  return readSecret(admin, pub.credentials_secret_id);
}
