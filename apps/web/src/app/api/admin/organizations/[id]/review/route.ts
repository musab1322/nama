import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, parseBody, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { mapOrgRpcError } from "@/lib/organizations";

export const runtime = "nodejs";

const Body = z.object({
  decision: z.enum(["verify", "reject"]),
  /** Donations inside the charity's apps (only with "verify"). */
  donationsEligible: z.boolean().default(false),
  note: z.string().trim().max(1000).optional(),
});

/**
 * POST /api/admin/organizations/{id}/review (FR-012c, FR-013)
 * verify: pending charity → verified (charity price from its next payment).
 * reject: pending → rejected, or revokes a verified charity; a note for the owner is required.
 * Recorded in audit_log by the database function.
 */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const { id } = await ctx.params;
  z.string().uuid().parse(id);
  const body = await parseBody(req, Body);
  const { data: status, error } = await adminClient().rpc("review_organization", {
    p_org_id: id,
    p_admin_id: user.id,
    p_approve: body.decision === "verify",
    p_donations: body.decision === "verify" && body.donationsEligible,
    p_note: body.note ?? null,
  });
  if (error) mapOrgRpcError(error);
  return json({ id, status });
});
