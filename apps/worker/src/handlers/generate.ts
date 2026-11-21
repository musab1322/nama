import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@banna/shared/errors";
import { refundCredits, settleCredits } from "@banna/shared/credits";
import { runGeneration } from "@banna/generator/pipeline";
import { AppSpecSchema } from "@banna/spec/schema";
import { diffSpecs } from "@banna/spec/diff";
import { PermanentError, RetryLater, type JobRow } from "../support";

const Payload = z.object({
  projectId: z.string().uuid(),
  specId: z.string().uuid(),
  userId: z.string().uuid(),
  cost: z.number().int().min(0),
  creditRef: z.string(),
});

/**
 * app.generate (FR-002, design §5.1): builds the code for a just-approved spec.
 * Queued by approve_spec, which already charged the credits; they are refunded
 * when the run fails for good.
 */
export async function appGenerate(admin: SupabaseClient, job: JobRow) {
  const p = Payload.safeParse(job.payload);
  if (!p.success) throw new PermanentError(`bad app.generate payload: ${p.error.message}`);
  const payload = p.data;
  try {
    return await generate(admin, payload);
  } catch (err) {
    const permanent = err instanceof PermanentError || (err instanceof HttpError && err.status < 500);
    if ((permanent || job.attempts >= job.max_attempts) && payload.cost > 0) {
      await refundCredits(admin, payload.userId, payload.cost, payload.creditRef);
    }
    if (err instanceof HttpError && err.status < 500) throw new PermanentError(`${err.code}: ${err.message}`);
    throw err;
  }
}

async function generate(admin: SupabaseClient, payload: z.infer<typeof Payload>) {
  const { data: row, error } = await admin
    .from("app_specs")
    .select("id, project_id, status, prompt, content, parent_spec_id")
    .eq("id", payload.specId)
    .single();
  if (error) throw error;
  if (row.project_id !== payload.projectId) throw new PermanentError("spec not in project");
  if (row.status !== "approved") throw new PermanentError("spec is no longer the approved one"); // a newer approval won

  const spec = AppSpecSchema.parse(row.content);

  // already built (job re-run after a crash between insert and finish)?
  const { data: existing } = await admin
    .from("project_versions")
    .select("id, credits_charged")
    .eq("project_id", payload.projectId)
    .eq("spec_id", payload.specId)
    .limit(1);
  if (existing?.length) {
    const v = existing[0]!;
    await settleCredits(admin, payload.userId, payload.cost, (v.credits_charged as number | null) ?? payload.cost, payload.creditRef);
    return { versionId: v.id, reused: true };
  }

  let specChanges = null;
  if (row.parent_spec_id) {
    const { data: parent } = await admin.from("app_specs").select("content").eq("id", row.parent_spec_id).maybeSingle();
    const before = parent ? AppSpecSchema.safeParse(parent.content) : null;
    if (before?.success) specChanges = diffSpecs(before.data, spec);
  }

  const { data: project } = await admin.from("projects").select("status").eq("id", payload.projectId).single();
  if (project?.status === "generating") throw new RetryLater("a cosmetic edit is running");

  const result = await runGeneration(admin, {
    projectId: payload.projectId,
    userId: payload.userId,
    prompt: row.prompt ?? "Build the app described in the approved spec.",
    kind: "spec_update",
    spec,
    specId: payload.specId,
    specChanges,
    held: payload.cost,
    baseVersionId: null,
  });
  // CR-004: keep only what the run actually cost
  await settleCredits(admin, payload.userId, payload.cost, result.creditsCharged, payload.creditRef);
  return { versionId: result.version.id, summary: result.summary, protectedFiles: result.protectedFiles, creditsCharged: result.creditsCharged };
}
