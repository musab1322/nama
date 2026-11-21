import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVersionFiles } from "@banna/shared/snapshots";
import { buildExport } from "@banna/integrations/export";
import { PermanentError, type JobRow } from "../support";

/** code.export (FR-016): zip → private bucket; the link is signed per request, valid 24 hours. */
export async function codeExport(admin: SupabaseClient, job: JobRow) {
  const { data: row, error } = await admin
    .from("code_exports")
    .select("id, project_id, version_id, status, projects!inner(name, slug)")
    .eq("id", job.payload.exportId as string)
    .single();
  if (error) throw error;
  if (row.status === "ready") return { already: true };

  try {
    const { version, files } = await loadVersionFiles(admin, row.version_id as string);
    const project = row.projects as unknown as { name: string; slug: string };
    const result = buildExport(files, { appName: project.name, slug: project.slug, version: version.version_number as number });
    const path = `${row.project_id}/${row.id}.zip`;
    const { error: upErr } = await admin.storage.from("code-exports").upload(path, result.zip, { contentType: "application/zip", upsert: true });
    if (upErr) throw upErr;
    const { error: doneErr } = await admin
      .from("code_exports")
      .update({ status: "ready", storage_path: path, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() })
      .eq("id", row.id);
    if (doneErr) throw doneErr;
    return { files: result.fileCount, removed: result.removed.length, redacted: result.redacted.length };
  } catch (err) {
    if (job.attempts >= job.max_attempts || err instanceof PermanentError) {
      await admin.from("code_exports").update({ status: "failed" }).eq("id", row.id);
    }
    throw err;
  }
}
