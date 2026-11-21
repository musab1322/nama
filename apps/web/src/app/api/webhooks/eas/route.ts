import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { verifyHmac } from "@banna/shared/crypto";
import { json } from "@/lib/http";
import { enqueueJob } from "@banna/shared/jobs";

export const runtime = "nodejs";

interface EasBuildEvent {
  id: string;
  platform: "ios" | "android";
  status: "finished" | "errored" | "canceled";
  artifacts?: { buildUrl?: string; logsS3KeyPrefix?: string };
  metadata?: { appVersion?: string; appBuildVersion?: string; runtimeVersion?: string };
  error?: { message?: string; errorCode?: string };
  buildDetailsPageUrl?: string;
}

interface EasSubmitEvent {
  id: string;
  turtleBuildId: string;
  platform: "ios" | "android";
  status: "finished" | "errored" | "canceled";
  submissionInfo?: { error?: { message?: string }; logsUrl?: string };
}

/**
 * POST /api/webhooks/eas?event=build|submit
 * Register with:  eas webhook:create --event BUILD  --url https://…/api/webhooks/eas?event=build  --secret …
 *                 eas webhook:create --event SUBMIT --url https://…/api/webhooks/eas?event=submit --secret …
 * Signature: expo-signature = "sha1=" + hex(HMAC-SHA1(rawBody, secret)).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyHmac("sha1", env().EXPO_WEBHOOK_SECRET, raw, req.headers.get("expo-signature"), "sha1=")) {
    return json({ error: "invalid signature" }, 401);
  }
  const kind = new URL(req.url).searchParams.get("event");
  const admin = adminClient();

  if (kind === "build") {
    const ev = JSON.parse(raw) as EasBuildEvent;
    const status = ev.status === "finished" ? "finished" : ev.status === "canceled" ? "canceled" : "errored";
    const { data: build, error } = await admin
      .from("mobile_builds")
      .update({
        status,
        runtime_version: ev.metadata?.runtimeVersion ?? undefined,
        logs_url: ev.buildDetailsPageUrl ?? null,
        error_message: ev.error?.message ?? null,
        completed_at: new Date().toISOString(),
      })
      .eq("build_provider", "eas")
      .eq("provider_build_id", ev.id)
      .in("status", ["queued", "in_progress"]) // idempotent on webhook retries
      .select("id, project_id")
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (build && status === "finished") {
      await enqueueJob(admin, "mobile.submit", { buildId: build.id }, {
        projectId: build.project_id as string,
        dedupeKey: `mobile.submit:${build.id}`,
        maxAttempts: 60, // waits (with backoff) while the store app record is being set up
      });
    }
    return json({ ok: true });
  }

  if (kind === "submit") {
    const ev = JSON.parse(raw) as EasSubmitEvent;
    const ok = ev.status === "finished";
    const { data: sub, error } = await admin
      .from("store_submissions")
      .update({
        status: ok ? "submitted" : "error",
        submitted_at: ok ? new Date().toISOString() : null,
        rejection_reason: ok ? null : (ev.submissionInfo?.error?.message ?? "Upload failed"),
      })
      .eq("submit_provider", "eas_submit")
      .eq("provider_submission_id", ev.id)
      .eq("status", "submitting")
      .select("id, project_id, platform")
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (sub && ok) {
      await enqueueJob(admin, "store.request_review", { submissionId: sub.id }, {
        projectId: sub.project_id as string,
        dedupeKey: `store.review:${sub.id}`,
        maxAttempts: 40, // Apple build processing takes 5-60 min
      });
    }
    return json({ ok: true });
  }

  return json({ ignored: true });
}
