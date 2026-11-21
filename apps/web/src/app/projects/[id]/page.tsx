import { notFound, redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { Workspace, type WorkspaceProject } from "@/components/workspace/Workspace";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const [{ data: project }, { data: profile }] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, slug, status, current_version_id, vercel_project_id")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("profiles").select("credits_balance").eq("id", auth.user.id).single(),
  ]);
  if (!project) notFound();

  return (
    <Workspace
      project={project as WorkspaceProject}
      credits={profile?.credits_balance ?? 0}
      rootDomain={process.env.PLATFORM_ROOT_DOMAIN ?? "yourplatform.app"}
    />
  );
}
