import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { SettingsView, type OrganizationView } from "@/app/settings/SettingsView";

export default async function SettingsPage() {
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?next=/settings");
  const [{ data: profile }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("credits_balance, email, full_name").eq("id", auth.user.id).single(),
    supabase
      .from("organizations")
      .select("id, kind, legal_name, license_number, verification_status, donations_eligible, review_note, reviewed_at")
      .maybeSingle(),
  ]);
  return (
    <SettingsView
      credits={profile?.credits_balance ?? 0}
      email={(profile?.email as string | null) ?? auth.user.email ?? ""}
      organization={(org as OrganizationView | null) ?? null}
    />
  );
}
