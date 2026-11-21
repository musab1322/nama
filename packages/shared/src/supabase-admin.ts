import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let admin: SupabaseClient | undefined;

/**
 * service_role client. Bypasses RLS — use ONLY on the server, and only after
 * ownership was checked with the user's own client (see requireOwnedProject).
 */
export function adminClient(): SupabaseClient {
  if (!admin) {
    const e = env();
    admin = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return admin;
}
