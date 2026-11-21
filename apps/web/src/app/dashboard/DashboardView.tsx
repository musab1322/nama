"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Apple, Globe, Plus, Smartphone, Wand2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { Alert, Button, Card } from "@/components/ui/index";
import { browserClient } from "@/lib/supabase/browser";
import { useRelativeTime, useT } from "@/i18n/client";

export interface ProjectCard {
  id: string;
  name: string;
  slug: string;
  status: string;
  updated_at: string;
  web_deployments: { status: string; alias_url: string | null; created_at: string }[];
  store_submissions: { status: string; platform: "ios" | "android"; created_at: string }[];
}

function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `app-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function DashboardView({ credits, projects }: { credits: number; projects: ProjectCard[] }) {
  const t = useT();
  const ago = useRelativeTime();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject() {
    setCreating(true);
    setError(null);
    const { data: auth } = await browserClient().auth.getUser();
    const { data, error } = await browserClient()
      .from("projects")
      .insert({ owner_id: auth.user?.id, name: t("dash.newName"), slug: randomSlug() })
      .select("id")
      .single();
    setCreating(false);
    if (error || !data) return setError(t("common.error"));
    router.push(`/projects/${data.id}`);
  }

  return (
    <div className="min-h-full">
      <AppHeader credits={credits} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">{t("dash.title")}</h1>
          <Button onClick={createProject} loading={creating}>
            <Plus className="size-4" />
            {t("dash.new")}
          </Button>
        </div>
        {error && <Alert tone="danger" className="mb-4">{error}</Alert>}

        {projects.length === 0 ? (
          <Card className="grid place-items-center gap-3 px-6 py-16 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-accent text-primary">
              <Wand2 className="size-7" />
            </div>
            <h2 className="text-lg font-semibold">{t("dash.empty.title")}</h2>
            <p className="max-w-sm text-sm text-muted-foreground">{t("dash.empty.body")}</p>
            <Button onClick={createProject} loading={creating} className="mt-2">
              <Plus className="size-4" />
              {t("dash.new")}
            </Button>
          </Card>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => {
              const web = p.web_deployments[0];
              const ios = p.store_submissions.find((s) => s.platform === "ios");
              const android = p.store_submissions.find((s) => s.platform === "android");
              return (
                <li key={p.id}>
                  <Link href={`/projects/${p.id}`} className="block focus-visible:outline-none">
                    <Card className="h-full p-4 transition hover:border-primary/50 hover:shadow-md">
                      <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h2 className="truncate font-semibold">{p.name}</h2>
                          <p className="ltr truncate text-xs text-muted-foreground">{p.slug}</p>
                        </div>
                        <StatusBadge status={p.status} />
                      </div>
                      <dl className="space-y-2 text-sm">
                        <Row icon={<Globe className="size-4" />} label={t("dash.web")}>
                          <StatusBadge status={web?.status ?? null} />
                        </Row>
                        <Row icon={<Apple className="size-4" />} label="iOS">
                          <StatusBadge status={ios?.status ?? null} />
                        </Row>
                        <Row icon={<Smartphone className="size-4" />} label="Android">
                          <StatusBadge status={android?.status ?? null} />
                        </Row>
                      </dl>
                      <p className="mt-4 text-xs text-muted-foreground">
                        {t("dash.updated")} {ago(p.updated_at)}
                      </p>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="flex items-center gap-2 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
