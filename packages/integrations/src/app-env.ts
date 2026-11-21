import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";

/**
 * Public build-time values every generated app reads (privacy notice, deep links).
 * None of them is secret; they are baked into the bundle.
 */
export async function appPublicEnv(admin: SupabaseClient, projectId: string): Promise<Record<string, string>> {
  const { data: p, error } = await admin
    .from("projects")
    .select("slug, app_config, owner_id, organizations(legal_name), app_backends(hosting)")
    .eq("id", projectId)
    .single();
  if (error) throw error;
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
  const org = one(p.organizations as { legal_name: string } | { legal_name: string }[] | null);
  const backend = one(p.app_backends as { hosting: string } | { hosting: string }[] | null);
  let owner = org?.legal_name ?? "";
  if (!owner) {
    const { data: profile } = await admin.from("profiles").select("full_name").eq("id", p.owner_id).maybeSingle();
    owner = (profile?.full_name as string | null) ?? "";
  }
  const config = (p.app_config ?? {}) as { support_email?: string };
  return {
    EXPO_PUBLIC_APP_OWNER: owner,
    EXPO_PUBLIC_CONTACT_EMAIL: config.support_email ?? "",
    EXPO_PUBLIC_DATA_LOCATION: backend?.hosting === "saudi" ? "sa" : "outside",
    EXPO_PUBLIC_APP_SCHEME: appScheme(p.slug as string),
    // FR-013: anyone can report the app to the platform, without an account
    EXPO_PUBLIC_REPORT_URL: new URL(`/report/${p.slug as string}`, env().PLATFORM_APP_URL).toString(),
  };
}

/** Deep-link scheme of an app (same rule as the native build's app.json). */
export const appScheme = (slug: string) => slug.replace(/[^a-z0-9]/g, "");
