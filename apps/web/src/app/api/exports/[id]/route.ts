import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/exports/{id}: status, and a download link while the export is valid (24 hours). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { supabase } = await requireUser();
  const id = z.string().uuid().parse((await params).id);
  const { data: row } = await supabase.from("code_exports").select("id, status, storage_path, expires_at, created_at").eq("id", id).maybeSingle();
  if (!row) throw new HttpError(404, "export_not_found", "Export not found");

  let url: string | null = null;
  if (row.status === "ready" && row.storage_path && row.expires_at) {
    const seconds = Math.floor((Date.parse(row.expires_at as string) - Date.now()) / 1000);
    if (seconds > 60) {
      const { data, error } = await adminClient().storage.from("code-exports").createSignedUrl(row.storage_path as string, Math.min(seconds, 86400), { download: true });
      if (error) throw error;
      url = data.signedUrl;
    }
  }
  return json({ export: { id: row.id, status: url || row.status !== "ready" ? row.status : "expired", expiresAt: row.expires_at, url } });
});
