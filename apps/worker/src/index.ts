/**
 * Mobile & backend orchestrator.
 * Run anywhere with Node 22 + npm (container, VM, or Vercel Sandbox):  npm run worker
 * Several workers can run in parallel: claim_jobs uses FOR UPDATE SKIP LOCKED with a lease.
 */
import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { applyBackendMigrations, provisionBackend, resumeBackend, suspendBackend } from "./handlers/backend";
import { billingRenew } from "./handlers/billing";
import { codeExport } from "./handlers/export";
import { accountPurge } from "./handlers/account";
import { mobileBuild, mobileOta, mobileSubmit, pollStoreStatus, requestReview } from "./handlers/mobile";
import { specDraft } from "./handlers/spec";
import { appGenerate } from "./handlers/generate";
import { PermanentError, RetryLater, type JobRow } from "./support";
import type { SupabaseClient } from "@supabase/supabase-js";

type Handler = (admin: SupabaseClient, job: JobRow) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  "backend.provision": provisionBackend,
  "backend.apply_migrations": applyBackendMigrations,
  "mobile.build": mobileBuild,
  "mobile.submit": mobileSubmit,
  "store.request_review": requestReview,
  "store.poll_status": pollStoreStatus,
  "mobile.ota": mobileOta,
  "spec.draft": specDraft,
  "app.generate": appGenerate,
  "billing.renew": billingRenew,
  "backend.suspend": suspendBackend,
  "backend.resume": resumeBackend,
  "code.export": codeExport,
  "account.purge": accountPurge,
};

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const IDLE_MS = 3_000;
let stopping = false;

async function processOne(admin: SupabaseClient, job: JobRow) {
  const handler = handlers[job.kind];
  if (!handler) {
    await admin.rpc("finish_job", { p_job_id: job.id, p_ok: false, p_error: `unknown job kind ${job.kind}`, p_retry: false });
    return;
  }
  const started = Date.now();
  try {
    const result = await handler(admin, job);
    await admin.rpc("finish_job", { p_job_id: job.id, p_ok: true, p_result: result ?? null });
    console.log(`[job ${job.id}] ${job.kind} ok in ${Date.now() - started}ms`);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 4000) : String(err);
    const retry = !(err instanceof PermanentError);
    const { data: status } = await admin.rpc("finish_job", { p_job_id: job.id, p_ok: false, p_error: message, p_retry: retry });
    const level = err instanceof RetryLater ? "info" : "error";
    console[level](`[job ${job.id}] ${job.kind} → ${status}: ${message}`);
  }
}

async function loop(slot: number) {
  const admin = adminClient();
  const workerId = `${env().WORKER_ID}#${slot}`;
  while (!stopping) {
    const { data, error } = await admin.rpc("claim_jobs", {
      p_worker: workerId,
      p_kinds: Object.keys(handlers),
      p_limit: 1,
      p_lease: "45 minutes",
    });
    if (error) {
      console.error("[worker] claim failed", error.message);
      await new Promise((r) => setTimeout(r, IDLE_MS * 5));
      continue;
    }
    const job = (data as JobRow[] | null)?.[0];
    if (!job) {
      await new Promise((r) => setTimeout(r, IDLE_MS));
      continue;
    }
    await processOne(admin, job);
  }
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}: finishing current jobs…`);
    stopping = true;
  });
}

env(); // fail fast on bad configuration
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => loop(i)));
console.log("[worker] stopped");
