import type { SupabaseClient } from "@supabase/supabase-js";

export type JobKind =
  | "backend.provision"
  | "backend.apply_migrations"
  | "mobile.build"
  | "mobile.submit"
  | "store.request_review"
  | "store.poll_status"
  | "mobile.ota"
  | "spec.draft"
  | "app.generate"
  | "billing.renew"
  | "backend.suspend"
  | "backend.resume"
  | "code.export"
  | "account.purge";

export async function enqueueJob(
  admin: SupabaseClient,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { projectId?: string; dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const { data, error } = await admin.rpc("enqueue_job", {
    p_kind: kind,
    p_payload: payload,
    p_project_id: opts.projectId ?? null,
    p_dedupe_key: opts.dedupeKey ?? null,
    p_run_after: (opts.runAfter ?? new Date()).toISOString(),
    p_max_attempts: opts.maxAttempts ?? 5,
  });
  if (error) throw error;
  return data as number;
}
