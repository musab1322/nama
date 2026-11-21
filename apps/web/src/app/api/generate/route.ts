import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { mapSpecRpcError } from "@/lib/specs";
import { classifyChange } from "@banna/generator/classify";
import { runGeneration } from "@banna/generator/pipeline";
import { creditBalance, holdFor, refundCredits, settleCredits, spendCredits, type AiUsage } from "@banna/shared/credits";
import { AppSpecSchema } from "@banna/spec/schema";

export const runtime = "nodejs";
export const maxDuration = 800; // an edit can take several minutes (Fluid Compute)

const Body = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(3).max(20000),
  /** Edit on top of a specific version (defaults to the current one). */
  baseVersionId: z.string().uuid().optional(),
});

/**
 * POST /api/generate (FR-002b, design §5.1 "التعديل")
 * Every edit is classified first:
 * - substantive (new screen, entity, payment…): a new spec is drafted on top of the
 *   approved one and the owner approves the difference; no code changes yet (202).
 * - cosmetic: generated now against the approved spec (201, a new version).
 * The first build of an app never comes through here: it follows spec approval.
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const admin = adminClient();

  if (project.status === "generating") {
    throw new HttpError(409, "generation_in_progress", "Another change is being generated");
  }

  const { data: pointer, error: pointerError } = await admin.from("projects").select("current_spec_id").eq("id", project.id).single();
  if (pointerError) throw pointerError;
  const { data: current } = pointer.current_spec_id
    ? await admin.from("app_specs").select("id, status, content").eq("id", pointer.current_spec_id).maybeSingle()
    : { data: null };
  if (!current || current.status !== "approved" || !project.current_version_id) {
    throw new HttpError(409, "spec_required", "Approve the app's spec first; the first build starts from it");
  }
  const spec = AppSpecSchema.parse(current.content);

  const balance = await creditBalance(admin, user.id);
  holdFor("specDraft", balance); // fail fast before paying for the classifier (both paths need at least this)
  const classifierUsage: AiUsage[] = [];
  const change = await classifyChange({ prompt: body.prompt, spec, onUsage: (u) => classifierUsage.push(u) });

  if (change.kind === "substantive") {
    const { data: jobId, error } = await admin.rpc("start_spec_draft", {
      p_project_id: project.id,
      p_user_id: user.id,
      p_cost: holdFor("specDraft", balance),
      p_payload: { prompt: body.prompt, category: spec.category, baseSpecId: current.id },
    });
    if (error) mapSpecRpcError(error);
    return json({ version: null, specChange: { jobId: jobId as number, reason: change.reason } }, 202);
  }

  const held = holdFor("edit", balance);
  const reference = `generate:${randomUUID()}`;
  await spendCredits(admin, user.id, held, reference);
  let result: Awaited<ReturnType<typeof runGeneration>>;
  try {
    result = await runGeneration(admin, {
      projectId: project.id,
      userId: user.id,
      prompt: body.prompt,
      kind: "cosmetic_edit",
      spec,
      specId: current.id,
      specChanges: null,
      held,
      priorUsage: classifierUsage,
      baseVersionId: body.baseVersionId ?? null,
    });
  } catch (err) {
    await refundCredits(admin, user.id, held, reference).catch(() => undefined);
    throw err;
  }
  // CR-004: keep only what the edit actually cost (the classifier included)
  await settleCredits(admin, user.id, held, result.creditsCharged, reference);
  return json({ ...result, specChange: null }, 201);
});
