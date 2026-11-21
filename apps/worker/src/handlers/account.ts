import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteProject } from "@banna/integrations/vercel";
import { RetryLater, type JobRow } from "../support";
import { destroyBackend } from "./backend";

const PROJECT_BUCKETS = ["project-sources", "project-assets", "build-artifacts", "code-exports"];

/** Removes every object under a folder of a bucket (Storage lists one level at a time). */
async function removePrefix(admin: SupabaseClient, bucket: string, prefix: string) {
  for (;;) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw error;
    if (!data?.length) return;
    const files = data.filter((o) => o.id).map((o) => `${prefix}/${o.name}`);
    for (const folder of data.filter((o) => !o.id)) await removePrefix(admin, bucket, `${prefix}/${folder.name}`);
    if (files.length) {
      const { error: rmError } = await admin.storage.from(bucket).remove(files);
      if (rmError) throw rmError;
    }
    if (data.length < 1000 && !files.length) return;
  }
}

/**
 * account.purge (UC-13, design §5.9): runs when the 7-day undo window is over.
 * Each step is idempotent, so a failed run continues on retry. Apps already in the
 * stores stay on the customer's own store accounts; they stop working with their backend.
 */
export async function accountPurge(admin: SupabaseClient, job: JobRow) {
  const userId = job.payload.userId as string;
  const { data: profile, error } = await admin.from("profiles").select("id, deletion_scheduled_for").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!profile) return { skipped: "already_deleted" };
  if (!profile.deletion_scheduled_for) return { skipped: "canceled" };
  if (new Date(profile.deletion_scheduled_for as string) > new Date()) throw new RetryLater("undo window still open");

  const { data: projects, error: pErr } = await admin.from("projects").select("id, vercel_project_id").eq("owner_id", userId);
  if (pErr) throw pErr;

  for (const p of projects ?? []) {
    const { data: backend } = await admin.from("app_backends").select("id").eq("project_id", p.id).maybeSingle();
    if (backend) await destroyBackend(admin, backend.id as string);
    if (p.vercel_project_id) await deleteProject(p.vercel_project_id as string);
    const { data: pay } = await admin.from("app_payment_accounts").select("pending_secret_id").eq("project_id", p.id).maybeSingle();
    if (pay?.pending_secret_id) await admin.rpc("vault_delete_secret", { p_secret_id: pay.pending_secret_id });
    for (const bucket of PROJECT_BUCKETS) await removePrefix(admin, bucket, p.id as string);
  }

  const { data: publishers } = await admin.from("publisher_accounts").select("id, credentials_secret_id").eq("owner_id", userId);
  for (const a of publishers ?? []) {
    if (a.credentials_secret_id) await admin.rpc("vault_delete_secret", { p_secret_id: a.credentials_secret_id });
  }
  await removePrefix(admin, "org-documents", userId);

  // last: the auth user; profiles and every platform row cascade (payments are kept, detached)
  const { error: delError } = await admin.auth.admin.deleteUser(userId);
  if (delError && !/not.?found/i.test(delError.message)) throw delError;
  return { purged: userId, projects: projects?.length ?? 0 };
}
