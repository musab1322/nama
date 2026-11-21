import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, parseBody, route } from "@/lib/http";
import { mapAdminRpcError } from "@/lib/admin-errors";

export const runtime = "nodejs";

const Body = z.object({
  projectSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  reason: z.enum(["illegal", "fraud", "abuse", "privacy", "copyright", "other"]),
  details: z.string().trim().max(4000).optional(),
  email: z.string().email().max(320).optional(),
});

/**
 * POST /api/reports (FR-013): anyone can report a generated app, without an account
 * (linked from every app's privacy page). Always answers 202 so it reveals nothing.
 */
export const POST = route(async (req) => {
  const body = await parseBody(req, Body);
  const { error } = await adminClient().rpc("submit_report", {
    p_project_slug: body.projectSlug,
    p_email: body.email ?? null,
    p_reason: body.reason,
    p_details: body.details ?? null,
  });
  if (error && !error.message?.includes("project_not_found")) mapAdminRpcError(error);
  return json({ received: true }, 202);
});
