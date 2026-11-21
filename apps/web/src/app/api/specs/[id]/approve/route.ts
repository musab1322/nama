import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { creditBalance, holdFor } from "@banna/shared/credits";
import { reviewSpec } from "@banna/policy/review";
import { HttpError, json, requireOwnedProject, requireUser, route } from "@/lib/http";
import { mapSpecRpcError, organizationFacts, requireOwnedSpec } from "@/lib/specs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/specs/{id}/approve (FR-002a, design §5.1)
 * Re-checks the spec, then in one transaction: charges the generation, supersedes
 * the previous approved spec, approves this one, points the project at it and
 * queues app.generate. Approved specs are immutable from here on.
 */
export const POST = route<Ctx>(async (_req, { params }) => {
  const { user, supabase } = await requireUser();
  const spec = await requireOwnedSpec(supabase, z.string().uuid().parse((await params).id));
  if (spec.status !== "draft") throw new HttpError(409, "spec_locked", "This spec is already approved or replaced");
  const project = await requireOwnedProject(supabase, spec.project_id);

  const admin = adminClient();
  const review = reviewSpec(spec.content, { organization: await organizationFacts(admin, spec.project_id) });
  if (!review.approvable) {
    throw new HttpError(422, "spec_invalid", "Fix the listed problems before approving", {
      issues: review.issues,
      findings: review.findings.filter((f) => f.severity === "blocking"),
    });
  }

  // CR-004: hold up to the operation's maximum; the worker returns what the build did not use
  const held = holdFor(project.current_version_id ? "edit" : "newApp", await creditBalance(admin, user.id));
  const { data: jobId, error } = await admin.rpc("approve_spec", { p_spec_id: spec.id, p_user_id: user.id, p_cost: held });
  if (error) mapSpecRpcError(error);

  return json({ jobId: jobId as number, specId: spec.id, creditsHeld: held }, 202);
});
