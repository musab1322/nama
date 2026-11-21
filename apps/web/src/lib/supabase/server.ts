import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@banna/shared/env";

/** Per-request client acting as the signed-in user (RLS applies). */
export async function userClient() {
  const cookieStore = await cookies();
  const e = env();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a context that cannot set cookies; middleware refreshes the session.
        }
      },
    },
  });
}
