import { adminClient } from "@banna/shared/supabase-admin";
import { json, route } from "@/lib/http";
import { requireAdmin } from "@/lib/admin";
import { ORG_COLUMNS, ORG_DOCUMENTS_BUCKET } from "@/lib/organizations";

export const runtime = "nodejs";

const STATUSES = ["pending", "verified", "rejected", "unverified"] as const;

/** GET /api/admin/organizations?status=pending: the charity review queue, with a 10-minute link to each document. */
export const GET = route(async (req) => {
  await requireAdmin();
  const param = new URL(req.url).searchParams.get("status");
  const status = STATUSES.find((s) => s === param) ?? "pending";
  const admin = adminClient();
  const { data, error } = await admin
    .from("organizations")
    .select(`${ORG_COLUMNS}, owner_id, document_path, profiles!organizations_owner_id_fkey(email, full_name)`)
    .eq("verification_status", status)
    .order("updated_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  const organizations = await Promise.all(
    (data ?? []).map(async ({ document_path, ...org }) => {
      if (!document_path) return { ...org, documentUrl: null };
      const { data: signed } = await admin.storage.from(ORG_DOCUMENTS_BUCKET).createSignedUrl(document_path as string, 600);
      return { ...org, documentUrl: signed?.signedUrl ?? null };
    }),
  );
  return json({ organizations });
});
