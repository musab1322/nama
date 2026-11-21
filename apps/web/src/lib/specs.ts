import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationFacts } from "@banna/policy/rules";
import { HttpError } from "@/lib/http";

export interface SpecRow {
  id: string;
  project_id: string;
  spec_number: number;
  parent_spec_id: string | null;
  prompt: string | null;
  content: unknown;
  markdown: string;
  status: "draft" | "approved" | "superseded";
  approved_at: string | null;
  created_at: string;
}

const SPEC_COLUMNS = "id, project_id, spec_number, parent_spec_id, prompt, content, markdown, status, approved_at, created_at";

/** Loads a spec through the USER's client, so RLS proves the caller owns its project. */
export async function requireOwnedSpec(supabase: SupabaseClient, specId: string): Promise<SpecRow> {
  const { data, error } = await supabase.from("app_specs").select(SPEC_COLUMNS).eq("id", specId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "spec_not_found", "Spec not found");
  return data as SpecRow;
}

export { SPEC_COLUMNS };

/** Facts the policy rules need about the project's organization (null = none linked). */
export async function organizationFacts(admin: SupabaseClient, projectId: string): Promise<OrganizationFacts | null> {
  const { data, error } = await admin
    .from("projects")
    .select("organizations(kind, verification_status, donations_eligible, apple_nonprofit_approved)")
    .eq("id", projectId)
    .single();
  if (error) throw error;
  const org = (data as { organizations: OrganizationFacts | OrganizationFacts[] | null }).organizations;
  return Array.isArray(org) ? (org[0] ?? null) : org;
}

const RPC_ERRORS: Record<string, [number, string]> = {
  insufficient_credits: [402, "Not enough credits"],
  draft_in_progress: [409, "A spec is already being written for this project"],
  spec_locked: [409, "Approved specs cannot be changed. Request a change to create a new spec."],
  generation_in_progress: [409, "Another change is being generated"],
  spec_not_found: [404, "Spec not found"],
  project_not_found: [404, "Project not found"],
};

/** Maps the named exceptions raised by start_spec_draft / approve_spec to API errors. */
export function mapSpecRpcError(err: { message?: string; code?: string } | null): never {
  const code = Object.keys(RPC_ERRORS).find((k) => err?.message?.includes(k));
  if (code) {
    const [status, message] = RPC_ERRORS[code]!;
    throw new HttpError(status, code, message);
  }
  if (err?.code === "55000") throw new HttpError(409, "spec_locked", RPC_ERRORS.spec_locked![1]);
  throw err;
}
