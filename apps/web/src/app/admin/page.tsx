import { notFound, redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { AdminView } from "@/app/admin/AdminView";

/** /admin (FR-013, design §7): platform admins only. Others get a 404, not a hint that it exists. */
export default async function AdminPage() {
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?next=/admin");
  const { data: profile } = await supabase.from("profiles").select("role, credits_balance").eq("id", auth.user.id).single();
  if (profile?.role !== "admin") notFound();
  return <AdminView credits={profile.credits_balance ?? 0} />;
}
