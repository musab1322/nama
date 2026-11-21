import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { creditBalance, holdFor } from "@banna/shared/credits";
import { CATEGORIES } from "@banna/spec/schema";
import { json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { mapSpecRpcError } from "@/lib/specs";

export const runtime = "nodejs";

const Body = z.object({
  projectId: z.string().uuid(),
  prompt: z.string().trim().min(3).max(20000),
  category: z.enum(CATEGORIES).optional(),
  /** Rewrite on top of this spec (defaults to the project's approved spec). */
  baseSpecId: z.string().uuid().optional(),
});

/**
 * POST /api/specs (FR-002a, design §5.1)
 * Charges the draft and queues spec.draft. The draft row arrives in app_specs
 * (Realtime) when the worker finishes; the job id lets the UI show progress or failure.
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const admin = adminClient();

  const held = holdFor("specDraft", await creditBalance(admin, user.id));
  const { data: jobId, error } = await admin.rpc("start_spec_draft", {
    p_project_id: project.id,
    p_user_id: user.id,
    p_cost: held,
    p_payload: {
      prompt: body.prompt,
      category: body.category ?? null,
      baseSpecId: body.baseSpecId ?? null,
    },
  });
  if (error) mapSpecRpcError(error);

  if (body.category) await admin.from("projects").update({ category: body.category }).eq("id", project.id);

  return json({ jobId: jobId as number, status: "drafting", creditsHeld: held }, 202);
});
