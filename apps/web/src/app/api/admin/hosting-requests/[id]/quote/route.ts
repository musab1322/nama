import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { json, parseBody, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { mapHostingRpcError } from "@/lib/hosting";

export const runtime = "nodejs";

const Body = z.object({
  setupSar: z.number().min(1).max(1_000_000),
  monthlySar: z.number().min(0).max(1_000_000),
  /** Shown to the owner, e.g. how many business days the first cell setup takes. */
  note: z.string().trim().max(2000).optional(),
});

/** POST /api/admin/hosting-requests/{id}/quote (FR-017): sets the price; a new quote voids any unpaid payment. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const { user } = await requireAdmin();
  const id = z.string().uuid().parse((await ctx.params).id);
  const body = await parseBody(req, Body);
  const { error } = await adminClient().rpc("quote_hosting_request", {
    p_request_id: id,
    p_admin_id: user.id,
    p_setup_halalas: Math.round(body.setupSar * 100),
    p_monthly_halalas: Math.round(body.monthlySar * 100),
    p_note: body.note ?? null,
  });
  if (error) mapHostingRpcError(error);
  return json({ id, status: "quoted" });
});
