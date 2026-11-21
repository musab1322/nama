import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { verifyHmac } from "@banna/shared/crypto";
import { json } from "@/lib/http";

export const runtime = "nodejs";

interface VercelEvent {
  type: string;
  payload: { deployment?: { id: string; url?: string }; target?: string | null };
}

/**
 * POST /api/webhooks/vercel
 * Subscribed events: deployment.succeeded, deployment.error, deployment.canceled.
 * Signature: x-vercel-signature = hex(HMAC-SHA1(rawBody, webhook secret)).
 */
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyHmac("sha1", env().VERCEL_WEBHOOK_SECRET, raw, req.headers.get("x-vercel-signature"))) {
    return json({ error: "invalid signature" }, 401);
  }
  const event = JSON.parse(raw) as VercelEvent;
  const deploymentId = event.payload.deployment?.id;
  if (!deploymentId) return json({ ignored: true });

  const status =
    event.type === "deployment.succeeded" || event.type === "deployment.ready"
      ? "ready"
      : event.type === "deployment.error"
        ? "error"
        : event.type === "deployment.canceled"
          ? "canceled"
          : null;
  if (!status) return json({ ignored: event.type });

  // Idempotent: only transitions out of queued/building; replays are no-ops.
  const { error } = await adminClient()
    .from("web_deployments")
    .update({
      status,
      ...(status === "ready" ? { ready_at: new Date().toISOString() } : {}),
      ...(status === "error" ? { error_code: "build_failed", error_message: "Build failed on Vercel" } : {}),
    })
    .eq("vercel_deployment_id", deploymentId)
    .in("status", ["queued", "building"]);
  if (error) return json({ error: error.message }, 500); // non-2xx → Vercel retries
  return json({ ok: true });
}
