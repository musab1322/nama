import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";
import { HttpError } from "@banna/shared/errors";
import { enqueueJob } from "@banna/shared/jobs";
import { AppSpecSchema, type AppSpec } from "@banna/spec/schema";
import { saudiCellConfigured, type HostingMode } from "./provider";

/**
 * Provisioning gate (FR-005, FR-012a/b, NFR-007, design §5.2):
 * an app's backend is created at its first paid publish, never before.
 * Previews run in the browser (PGlite) and cost nothing.
 */

/** True when the spec stores anything or signs anyone in. A static app needs no backend at all. */
export function needsBackend(spec: AppSpec): boolean {
  return spec.entities.length > 0 || spec.auth.required || spec.auth.methods.length > 0 || spec.payments.mode !== "none";
}

interface SubscriptionRow {
  status: string;
  plan: string;
  current_period_end: string | null;
  grace_until: string | null;
  plans: PlanRef | PlanRef[] | null;
}
type PlanRef = { price_halalas: number; features?: Record<string, unknown> | null };

/** A paid plan that is active, trialing, or past due but still inside its grace period (FR-012b). */
export function isPaidSubscription(s: SubscriptionRow, now = new Date()): boolean {
  const plan = Array.isArray(s.plans) ? s.plans[0] : s.plans;
  const paid = plan ? plan.price_halalas > 0 : s.plan !== "free";
  if (!paid) return false;
  const inPeriod = !s.current_period_end || new Date(s.current_period_end) > now;
  if (s.status === "active" || s.status === "trialing") return inPeriod;
  if (s.status === "past_due") return !!s.grace_until && new Date(s.grace_until) > now;
  return false;
}

/** True when a live paid plan of the user includes the feature (plans.features, e.g. code_export). */
export async function hasPlanFeature(admin: SupabaseClient, userId: string, feature: string): Promise<boolean> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("status, plan, current_period_end, grace_until, plans(price_halalas, features)")
    .eq("user_id", userId);
  if (error) throw error;
  return ((data ?? []) as unknown as SubscriptionRow[]).some((s) => {
    const plan = Array.isArray(s.plans) ? s.plans[0] : s.plans;
    return isPaidSubscription(s) && plan?.features?.[feature] === true;
  });
}

export async function hasPaidPlan(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("status, plan, current_period_end, grace_until, plans(price_halalas)")
    .eq("user_id", userId);
  if (error) throw error;
  return ((data ?? []) as SubscriptionRow[]).some((s) => isPaidSubscription(s));
}

export type FollowUp = { kind: "deploy.web"; versionId: string; target: "production" | "preview"; userId: string };

export type BackendState =
  | { state: "not_needed" }
  | { state: "active"; backendId: string }
  | { state: "provisioning"; backendId: string; jobId: number | null };

/**
 * Returns the backend state, creating the backend (and its provision job) the
 * first time a paid owner publishes. Throws 402 plan_required for free owners.
 */
export async function ensureBackend(
  admin: SupabaseClient,
  project: { id: string; owner_id: string },
  opts: { followUp?: FollowUp } = {},
): Promise<BackendState> {
  const { data: p, error: pErr } = await admin.from("projects").select("current_spec_id, suspended_at").eq("id", project.id).single();
  if (pErr) throw pErr;
  if (p.suspended_at) throw new HttpError(423, "project_suspended", "This app is suspended by the platform; contact support");
  const { data: existing, error } = await admin
    .from("app_backends")
    .select("id, status, hosting")
    .eq("project_id", project.id)
    .maybeSingle();
  if (error) throw error;
  if (existing?.status === "active") return { state: "active", backendId: existing.id as string };

  if (p.current_spec_id && !existing) {
    const { data: specRow } = await admin.from("app_specs").select("content").eq("id", p.current_spec_id).maybeSingle();
    const spec = specRow ? AppSpecSchema.safeParse(specRow.content) : null;
    if (spec?.success && !needsBackend(spec.data)) return { state: "not_needed" };
  }

  if (!(await hasPaidPlan(admin, project.owner_id))) {
    throw new HttpError(402, "plan_required", "Publishing needs a paid plan");
  }

  const hosting = (existing?.hosting as HostingMode | undefined) ?? (await chosenHosting(admin, project.id));
  if (hosting === "saudi" && !saudiCellConfigured(env())) {
    // FR-017: the first in-Kingdom request also sets up the cell (business days, told before payment)
    throw new HttpError(409, "saudi_cell_pending", "In-Kingdom hosting is being prepared; publishing starts once it is ready");
  }

  let backendId = existing?.id as string | undefined;
  if (!backendId) {
    const { data: created, error: insErr } = await admin
      .from("app_backends")
      .upsert(
        {
          project_id: project.id,
          hosting,
          organization_slug: hosting === "standard" ? env().SUPABASE_APPS_ORG_SLUG : null,
          region_code: hosting === "standard" ? env().SUPABASE_APPS_REGION_GROUP : null,
          status: "provisioning",
        },
        { onConflict: "project_id", ignoreDuplicates: false },
      )
      .select("id")
      .single();
    if (insErr) throw insErr;
    backendId = created.id as string;
  }

  if (existing && existing.status !== "provisioning") {
    // suspended / failed backends are handled by admins and billing, not by a publish click
    throw new HttpError(409, "backend_unavailable", `The app's database is ${existing.status}`);
  }

  const jobId = await enqueueJob(
    admin,
    "backend.provision",
    { appBackendId: backendId, ...(opts.followUp ? { followUp: opts.followUp } : {}) },
    { projectId: project.id, dedupeKey: `backend.provision:${project.id}`, maxAttempts: 40 },
  );
  return { state: "provisioning", backendId, jobId };
}

/** Saudi hosting only once its setup fee is paid (FR-017); standard otherwise. */
async function chosenHosting(admin: SupabaseClient, projectId: string): Promise<HostingMode> {
  const { data } = await admin
    .from("hosting_requests")
    .select("id")
    .eq("project_id", projectId)
    .in("status", ["paid", "provisioning", "migrating", "active"])
    .limit(1);
  return data?.length ? "saudi" : "standard";
}

/**
 * Takes a published-app slot for the project (CR-004 / BUG-004): plan apps plus bought
 * extra apps. Idempotent for an app that is already published.
 */
export async function claimPublishSlot(admin: SupabaseClient, projectId: string, userId: string): Promise<void> {
  const { error } = await admin.rpc("claim_publish_slot", { p_project_id: projectId, p_user_id: userId });
  if (!error) return;
  if (error.message.includes("app_limit_reached")) {
    throw new HttpError(402, "app_limit_reached", "Your plan's published apps are in use; add an extra app or upgrade");
  }
  if (error.message.includes("project_not_found")) throw new HttpError(404, "project_not_found", "Project not found");
  throw error;
}
