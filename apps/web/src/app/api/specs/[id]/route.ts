import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { renderSpecMarkdown } from "@banna/spec/render";
import { reviewSpec } from "@banna/policy/review";
import { HttpError, json, parseBody, requireUser, route } from "@/lib/http";
import { SPEC_COLUMNS, mapSpecRpcError, organizationFacts, requireOwnedSpec } from "@/lib/specs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const Id = z.string().uuid();

/** GET /api/specs/{id}: the spec plus everything the review screen shows (issues, store findings). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { supabase } = await requireUser();
  const spec = await requireOwnedSpec(supabase, Id.parse((await params).id));
  const review = reviewSpec(spec.content, { organization: await organizationFacts(adminClient(), spec.project_id) });
  return json({ spec, issues: review.issues, findings: review.findings, approvable: review.approvable });
});

const Patch = z.object({ content: z.record(z.string(), z.unknown()) });

/**
 * PATCH /api/specs/{id} (FR-002a): the owner edits a draft. The shape must be valid
 * to save; semantic issues are returned so the owner can keep fixing before approval.
 */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const { supabase } = await requireUser();
  const spec = await requireOwnedSpec(supabase, Id.parse((await params).id));
  const body = await parseBody(req, Patch);
  if (spec.status !== "draft") throw new HttpError(409, "spec_locked", "Approved specs cannot be changed");

  const admin = adminClient();
  const review = reviewSpec(body.content, { organization: await organizationFacts(admin, spec.project_id) });
  if (!review.spec) throw new HttpError(422, "spec_invalid", "The spec is not in the expected format", review.issues);

  const { data, error } = await admin
    .from("app_specs")
    .update({ content: review.spec, markdown: renderSpecMarkdown(review.spec) })
    .eq("id", spec.id)
    .eq("status", "draft") // the trigger also refuses edits to approved specs
    .select(SPEC_COLUMNS)
    .maybeSingle();
  if (error) mapSpecRpcError(error);
  if (!data) throw new HttpError(409, "spec_locked", "Approved specs cannot be changed");

  return json({ spec: data, issues: review.issues, findings: review.findings, approvable: review.approvable });
});
