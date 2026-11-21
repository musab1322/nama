import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { DashboardView, type ProjectCard } from "@/app/dashboard/DashboardView";

export default async function DashboardPage() {
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const [{ data: profile }, { data: projects }] = await Promise.all([
    supabase.from("profiles").select("credits_balance").eq("id", auth.user.id).single(),
    supabase
      .from("projects")
      .select(
        "id, name, slug, status, updated_at, icon_path, web_deployments(status, alias_url, created_at), store_submissions(status, platform, created_at)",
      )
      .neq("status", "archived")
      .order("updated_at", { ascending: false })
      .order("created_at", { referencedTable: "web_deployments", ascending: false })
      .limit(1, { referencedTable: "web_deployments" })
      .order("created_at", { referencedTable: "store_submissions", ascending: false })
      .limit(4, { referencedTable: "store_submissions" }),
  ]);

  return <DashboardView credits={profile?.credits_balance ?? 0} projects={(projects ?? []) as unknown as ProjectCard[]} />;
}
