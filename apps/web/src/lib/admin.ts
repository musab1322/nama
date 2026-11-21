import type { User } from "@supabase/supabase-js";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, requireUser } from "@/lib/http";

/** Platform admins only (profiles.role, which users cannot change). FR-013, design §7. */
export async function requireAdmin(): Promise<{ user: User }> {
  const { user } = await requireUser();
  const { data, error } = await adminClient().from("profiles").select("role").eq("id", user.id).single();
  if (error) throw error;
  if (data.role !== "admin") throw new HttpError(403, "forbidden", "Admins only");
  return { user };
}
