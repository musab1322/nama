import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@banna/shared/errors";
import { creditsForUsage, refundCredits, settleCredits, type AiUsage } from "@banna/shared/credits";
import { draftSpec } from "@banna/generator/spec-draft";
import { AppSpecSchema, CATEGORIES, type AppSpec } from "@banna/spec/schema";
import { validateSpec } from "@banna/spec/validate";
import { renderSpecMarkdown } from "@banna/spec/render";
import { PermanentError, type JobRow } from "../support";

const Payload = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  prompt: z.string().min(3).max(20000),
  category: z.enum(CATEGORIES).nullable(),
  baseSpecId: z.string().uuid().nullable(),
  creditRef: z.string(),
  cost: z.number().int().min(0),
});

/**
 * spec.draft (FR-002a): description → AppSpec draft row in app_specs.
 * The UI receives the row through Realtime. Semantic issues do not fail the job:
 * the draft is saved and the review screen shows them for the owner to fix.
 */
export async function specDraft(admin: SupabaseClient, job: JobRow) {
  const p = Payload.safeParse(job.payload);
  if (!p.success) throw new PermanentError(`bad spec.draft payload: ${p.error.message}`);
  const payload = p.data;
  try {
    return await draft(admin, payload);
  } catch (err) {
    const permanent = err instanceof PermanentError || (err instanceof HttpError && err.status < 500);
    // attempts was incremented when the job was claimed
    if ((permanent || job.attempts >= job.max_attempts) && payload.cost > 0) {
      await refundCredits(admin, payload.userId, payload.cost, payload.creditRef);
    }
    if (err instanceof HttpError && err.status < 500) throw new PermanentError(`${err.code}: ${err.message}`);
    throw err;
  }
}

async function draft(admin: SupabaseClient, payload: z.infer<typeof Payload>) {
  const current = await loadBaseSpec(admin, payload.projectId, payload.baseSpecId);

  const usages: AiUsage[] = [];
  const onUsage = (u: AiUsage) => usages.push(u);
  let raw = await draftSpec({ prompt: payload.prompt, category: payload.category, current: current?.content ?? null, repair: null, onUsage });
  let result = validateSpec(raw);
  if (result.issues.length) {
    // one repair pass with the exact problems; most issues are naming slips
    raw = await draftSpec({
      prompt: payload.prompt,
      category: payload.category,
      current: current?.content ?? null,
      repair: { previous: raw, issues: result.issues },
      onUsage,
    });
    const repaired = validateSpec(raw);
    if (repaired.spec || !result.spec) result = repaired;
  }
  if (!result.spec) throw new PermanentError(`spec failed validation: ${result.issues.map((i) => i.path).join(", ")}`);
  const spec = result.spec;

  const { data, error } = await admin
    .from("app_specs")
    .insert({
      project_id: payload.projectId,
      spec_number: 1, // assigned by trigger
      parent_spec_id: current?.id ?? null,
      prompt: payload.prompt,
      content: spec,
      markdown: renderSpecMarkdown(spec),
      created_by: payload.userId,
    })
    .select("id, spec_number")
    .single();
  if (error) throw error;

  // first spec of a new project: adopt its name and category
  const { data: project } = await admin.from("projects").select("current_version_id, category").eq("id", payload.projectId).single();
  if (project && !project.current_version_id) {
    await admin
      .from("projects")
      .update({ name: spec.name.slice(0, 80), ...(project.category ? {} : { category: spec.category }) })
      .eq("id", payload.projectId);
  }

  // CR-004: keep only what the drafts actually cost
  const charged = payload.cost > 0 ? creditsForUsage(usages, payload.cost) : 0;
  if (payload.cost > 0) await settleCredits(admin, payload.userId, payload.cost, charged, payload.creditRef);

  return { specId: data.id, specNumber: data.spec_number, issues: result.issues.length, creditsCharged: charged };
}

async function loadBaseSpec(
  admin: SupabaseClient,
  projectId: string,
  baseSpecId: string | null,
): Promise<{ id: string; content: AppSpec } | null> {
  let id = baseSpecId;
  if (!id) {
    const { data } = await admin.from("projects").select("current_spec_id").eq("id", projectId).single();
    id = (data?.current_spec_id as string | null) ?? null;
  }
  if (!id) return null;
  const { data, error } = await admin.from("app_specs").select("id, project_id, content").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || data.project_id !== projectId) throw new PermanentError("base spec not in project");
  const parsed = AppSpecSchema.safeParse(data.content);
  return parsed.success ? { id: data.id as string, content: parsed.data } : null;
}
