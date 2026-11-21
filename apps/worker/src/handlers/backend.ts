import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";
import { randomSecret, sha256 } from "@banna/shared/crypto";
import { enqueueJob } from "@banna/shared/jobs";
import { loadVersionFiles } from "@banna/shared/snapshots";
import { SupabaseMgmtError } from "@banna/backends/supabase-management";
import { CellControlError } from "@banna/backends/saudi-cell";
import { ProviderUnavailableError, type HostingMode } from "@banna/backends/provider";
import { providerFor, saudiCellConfigured } from "@banna/backends/registry";
import type { FollowUp } from "@banna/backends/ensure";
import { MIGRATIONS_DIR } from "@banna/generator/pipeline";
import { deployWeb } from "@banna/integrations/deploy-web";
import { appScheme } from "@banna/integrations/app-env";
import type { OwnedProject } from "@banna/shared/errors";
import { PermanentError, RetryLater, type JobRow } from "../support";

interface BackendRow {
  id: string;
  project_id: string;
  hosting: HostingMode;
  supabase_project_ref: string | null;
  cell_app_id: string | null;
  region_code: string | null;
  instance_size: string | null;
  status: string;
  db_password_secret_id: string | null;
  projects: OwnedProject & { suspended_at?: string | null };
}

async function loadBackend(admin: SupabaseClient, id: string): Promise<BackendRow> {
  const { data, error } = await admin
    .from("app_backends")
    .select(
      "id, project_id, hosting, supabase_project_ref, cell_app_id, region_code, instance_size, status, db_password_secret_id, " +
        "projects!inner(id, owner_id, name, slug, status, current_version_id, vercel_project_id, eas_project_id, app_config, suspended_at)",
    )
    .eq("id", id)
    .single();
  if (error) throw error;
  return data as unknown as BackendRow;
}

const refOf = (b: BackendRow) => (b.hosting === "standard" ? b.supabase_project_ref : b.cell_app_id);

function provider(b: BackendRow) {
  // ensureBackend does not queue Saudi work before the cell exists; this guards older jobs
  if (b.hosting === "saudi" && !saudiCellConfigured(env())) throw new PermanentError("The Saudi cell is not set up yet");
  try {
    return providerFor(b.hosting);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) throw new PermanentError(err.message);
    throw err;
  }
}

/**
 * backend.provision (design §5.2): runs only after ensureBackend passed the paid-plan gate.
 * Resumable: every step is skipped when already done. The database gets the
 * app's full schema before the backend is marked active.
 */
export async function provisionBackend(admin: SupabaseClient, job: JobRow) {
  let backend = await loadBackend(admin, job.payload.appBackendId as string);
  const followUp = (job.payload.followUp ?? null) as FollowUp | null;
  if (backend.status === "active") return { already: true, followUp: await runFollowUp(admin, backend, followUp) };
  if (backend.status !== "provisioning") throw new PermanentError(`backend is ${backend.status}`);
  const p = provider(backend);
  const slug = backend.projects.slug;

  // 1. create (once). The DB password goes to Vault before the provider sees it.
  let ref = refOf(backend);
  if (!ref) {
    const dbPass = randomSecret(32);
    const { data: secretId, error: vErr } = await admin.rpc("vault_store_secret", {
      p_secret: dbPass,
      p_name: `appdb:${backend.id}`,
      p_description: `DB password for app ${slug}`,
    });
    if (vErr) throw vErr;
    let created;
    try {
      created = await p.create({ name: `app-${slug}`, dbPassword: dbPass, region: backend.region_code, instanceSize: backend.instance_size });
    } catch (err) {
      await admin.rpc("vault_delete_secret", { p_secret_id: secretId });
      if (err instanceof SupabaseMgmtError && err.status === 402) throw new PermanentError("Supabase organization billing/limit reached");
      throw err;
    }
    ref = created.ref;
    const { error } = await admin
      .from("app_backends")
      .update({
        ...(backend.hosting === "standard" ? { supabase_project_ref: ref } : { cell_app_id: ref }),
        db_password_secret_id: secretId,
        api_url: created.apiUrl,
      })
      .eq("id", backend.id);
    if (error) throw error;
  }

  // 2. wait until healthy (usually 1-3 minutes)
  if (!(await p.isReady(ref))) throw new RetryLater("backend is still starting");

  // 3. keys, auth redirects, account deletion function
  const site = `https://${slug}.${env().PLATFORM_ROOT_DOMAIN}`;
  const scheme = appScheme(slug);
  const keys = await p.configure(ref, { siteUrl: site, redirectUrls: [`${site}/**`, `${scheme}://**`, "exp://**"] });
  const { data: secretKeyId, error: skErr } = await admin.rpc("vault_store_secret", {
    p_secret: keys.secret,
    p_name: `appsecret:${backend.id}:${Date.now()}`,
    p_description: `Secret API key for app ${slug}`,
  });
  if (skErr) throw skErr;
  const { error: keyErr } = await admin
    .from("app_backends")
    .update({ publishable_key: keys.publishable, secret_key_secret_id: secretKeyId })
    .eq("id", backend.id);
  if (keyErr) throw keyErr;

  // 4. platform server functions (account deletion, payments) and their settings
  backend = await loadBackend(admin, backend.id);
  await deployPlatformFunctions(admin, backend, ref);
  await p.setSecret(ref, "APP_SITE_URL", site);
  await p.setSecret(ref, "APP_SCHEME", scheme);
  await pushPendingPaymentSecret(admin, backend, ref);

  // 5. the schema generated so far (kept in the version snapshot) on the empty database
  await syncMigrationsFromSnapshot(admin, backend);
  const applied = await applyPending(admin, backend, ref, { initial: true });

  const { error } = await admin
    .from("app_backends")
    .update({ status: "active", provisioned_at: new Date().toISOString(), last_error: null })
    .eq("id", backend.id);
  if (error) throw error;
  if (backend.hosting === "saudi") {
    // FR-017: the paid in-Kingdom request is fulfilled
    const { error: hrError } = await admin
      .from("hosting_requests")
      .update({ status: "active" })
      .eq("project_id", backend.project_id)
      .in("status", ["paid", "provisioning"]);
    if (hrError) throw hrError;
  }
  // a version generated during the last steps may have queued rows after the sync
  await enqueueJob(admin, "backend.apply_migrations", { appBackendId: backend.id }, {
    projectId: backend.project_id,
    dedupeKey: `backend.migrate:${backend.project_id}`,
  });

  return { ref, applied, followUp: await runFollowUp(admin, { ...backend, status: "active" }, followUp) };
}

/** backend.apply_migrations: applies pending migrations in order; stops at the first failure or blocked one. */
export async function applyBackendMigrations(admin: SupabaseClient, job: JobRow) {
  const backend = await loadBackend(admin, job.payload.appBackendId as string);
  const ref = refOf(backend);
  if (backend.status !== "active" || !ref) throw new RetryLater("backend not active yet");
  return { applied: await applyPending(admin, backend, ref, { initial: false }) };
}

/**
 * Turns supabase/migrations/*.sql of the current version into backend_migrations
 * rows (idempotent by checksum). On the first provisioning the database is
 * empty, so nothing is destructive yet.
 */
export async function syncMigrationsFromSnapshot(admin: SupabaseClient, backend: BackendRow) {
  const versionId = backend.projects.current_version_id;
  if (!versionId) return 0;
  const { files } = await loadVersionFiles(admin, versionId);
  const rows = migrationRowsFromFiles(files).map((m) => ({
    project_id: backend.project_id,
    app_backend_id: backend.id,
    version_id: versionId,
    name: m.name,
    sql: m.sql,
    checksum: m.checksum,
    is_destructive: false,
    status: "pending",
  }));
  if (!rows.length) return 0;
  const { error } = await admin
    .from("backend_migrations")
    .upsert(rows, { onConflict: "app_backend_id,checksum", ignoreDuplicates: true });
  if (error) throw error;
  return rows.length;
}

/** Moves an owner's Moyasar secret that waited in the platform Vault into the app's backend (FR-014). */
export async function pushPendingPaymentSecret(admin: SupabaseClient, backend: BackendRow, ref: string) {
  const { data: acct } = await admin
    .from("app_payment_accounts")
    .select("id, pending_secret_id")
    .eq("project_id", backend.project_id)
    .maybeSingle();
  if (!acct?.pending_secret_id) return false;
  const { data: secret, error } = await admin.rpc("vault_read_secret", { p_secret_id: acct.pending_secret_id });
  if (error) throw error;
  await provider(backend).setSecret(ref, "MOYASAR_SECRET_KEY", secret as string);
  const { error: upErr } = await admin
    .from("app_payment_accounts")
    .update({ status: "active", secret_stored_at: new Date().toISOString(), pending_secret_id: null })
    .eq("id", acct.id);
  if (upErr) throw upErr;
  await admin.rpc("vault_delete_secret", { p_secret_id: acct.pending_secret_id });
  return true;
}

/** Functions that are called without a user token (payment provider webhooks). */
const PUBLIC_FUNCTIONS = new Set(["payments"]);

/** Deploys supabase/functions/<name>/index.ts from the current version (platform-owned files). */
export async function deployPlatformFunctions(admin: SupabaseClient, backend: BackendRow, ref: string) {
  const versionId = backend.projects.current_version_id;
  if (!versionId) return [];
  const { files } = await loadVersionFiles(admin, versionId);
  const fns = functionsFromFiles(files);
  for (const fn of fns) await provider(backend).deployFunction(ref, fn.name, fn.source, { verifyJwt: !PUBLIC_FUNCTIONS.has(fn.name) });
  return fns.map((f) => f.name);
}

export function functionsFromFiles(files: Record<string, string>) {
  return Object.keys(files)
    .map((p) => p.match(/^supabase\/functions\/([a-z][a-z0-9-]{1,40})\/index\.ts$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1]!, source: files[m[0]]! }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Migration files in apply order (their names start with a timestamp). */
export function migrationRowsFromFiles(files: Record<string, string>) {
  return Object.keys(files)
    .filter((p) => p.startsWith(MIGRATIONS_DIR) && p.endsWith(".sql"))
    .sort()
    .map((p) => {
      const sql = files[p]!;
      return { name: p.slice(MIGRATIONS_DIR.length, -4).slice(0, 120), sql, checksum: sha256(sql) };
    });
}

async function applyPending(admin: SupabaseClient, backend: BackendRow, ref: string, opts: { initial: boolean }) {
  const p = provider(backend);
  const { data: rows, error } = await admin
    .from("backend_migrations")
    .select("id, name, sql, status")
    .eq("app_backend_id", backend.id)
    .in("status", ["pending", "blocked"])
    .order("created_at")
    .order("name");
  if (error) throw error;

  let applied = 0;
  for (const m of rows ?? []) {
    if (m.status === "blocked" && !opts.initial) break; // destructive change waits for the owner's approval
    try {
      await p.applyMigration(ref, m.name as string, m.sql as string);
      await admin.from("backend_migrations").update({ status: "applied", applied_at: new Date().toISOString() }).eq("id", m.id);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 2000) : "failed";
      await admin.from("backend_migrations").update({ status: "failed", error_message: message }).eq("id", m.id);
      throw new PermanentError(`migration ${m.name} failed: ${message}`);
    }
  }

  if (applied) {
    const errors = await p.securityErrors(ref).catch(() => []);
    await admin
      .from("app_backends")
      .update({
        last_migration_at: new Date().toISOString(),
        last_error: errors.length ? `Security advisor: ${errors.join(", ")}` : null,
      })
      .eq("id", backend.id);
  }
  return applied;
}

/**
 * The publish that triggered provisioning continues on its own once the backend is live.
 * Its failure is reported in the job result, never undoes the (paid) backend.
 */
async function runFollowUp(admin: SupabaseClient, backend: BackendRow, followUp: FollowUp | null) {
  if (!followUp) return null;
  try {
    if (followUp.kind === "deploy.web") {
      await deployWeb(admin, backend.projects, followUp);
      return { kind: followUp.kind, ok: true };
    }
  } catch (err) {
    console.error(`[backend ${backend.id}] follow-up ${followUp.kind} failed`, err);
    return { kind: followUp.kind, ok: false, error: err instanceof Error ? err.message.slice(0, 500) : "failed" };
  }
  return null;
}

/**
 * backend.suspend: stops an app's backend (lapsed plan or an admin action). Data is
 * kept; resuming restores it. Deletion is never automatic.
 */
export async function suspendBackend(admin: SupabaseClient, job: JobRow) {
  const backend = await loadBackend(admin, job.payload.appBackendId as string);
  const ref = refOf(backend);
  if (backend.status !== "active" || !ref) return { skipped: backend.status };
  // an admin lifted the suspension before this job ran
  if (job.payload.reason === "admin" && !backend.projects.suspended_at) return { skipped: "unsuspended" };
  await provider(backend).suspend(ref);
  const { error } = await admin
    .from("app_backends")
    .update({ status: "paused", last_error: `suspended: ${String(job.payload.reason ?? "admin")}`.slice(0, 200) })
    .eq("id", backend.id);
  if (error) throw error;
  return { suspended: backend.id };
}

/** backend.resume: restarts a paused backend (the owner paid again, or an admin lifted a suspension). */
export async function resumeBackend(admin: SupabaseClient, job: JobRow) {
  const backend = await loadBackend(admin, job.payload.appBackendId as string);
  const ref = refOf(backend);
  if (backend.status !== "paused" || !ref) return { skipped: backend.status };
  if (backend.projects.suspended_at) return { skipped: "suspended_by_admin" };
  const p = provider(backend);
  if (!(await p.isReady(ref).catch(() => false))) {
    if (!job.payload.restoreRequested) {
      await p.resume(ref);
      await admin.from("jobs").update({ payload: { ...job.payload, restoreRequested: true } }).eq("id", job.id);
    }
    throw new RetryLater("backend is restarting");
  }
  const { error } = await admin.from("app_backends").update({ status: "active", last_error: null }).eq("id", backend.id);
  if (error) throw error;
  return { resumed: backend.id };
}

/** Account deletion (UC-13): destroys the app's backend and its keys, then removes the row. */
export async function destroyBackend(admin: SupabaseClient, appBackendId: string) {
  const { data: row, error } = await admin
    .from("app_backends")
    .select("id, hosting, supabase_project_ref, cell_app_id, status, secret_key_secret_id, db_password_secret_id")
    .eq("id", appBackendId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return { skipped: "gone" };
  const ref = (row.hosting === "standard" ? row.supabase_project_ref : row.cell_app_id) as string | null;
  if (ref && row.status !== "deleted") {
    await admin.from("app_backends").update({ status: "deleting" }).eq("id", row.id);
    try {
      await providerFor(row.hosting as HostingMode).destroy(ref);
    } catch (err) {
      // already gone at the provider is fine; anything else retries the job
      const status = (err as { status?: number }).status;
      if (!((err instanceof SupabaseMgmtError || err instanceof CellControlError) && status === 404)) throw err;
    }
  }
  for (const secretId of [row.secret_key_secret_id, row.db_password_secret_id]) {
    if (secretId) await admin.rpc("vault_delete_secret", { p_secret_id: secretId });
  }
  const { error: delError } = await admin.from("app_backends").delete().eq("id", row.id);
  if (delError) throw delError;
  return { destroyed: row.id };
}
