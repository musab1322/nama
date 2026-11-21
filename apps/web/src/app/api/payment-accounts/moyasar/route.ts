import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { verifySecretKey } from "@banna/integrations/moyasar";
import { providerFor } from "@banna/backends/registry";
import type { HostingMode } from "@banna/backends/provider";

export const runtime = "nodejs";

const Body = z
  .object({
    projectId: z.string().uuid(),
    publishableKey: z.string().regex(/^pk_(live|test)_[A-Za-z0-9]+$/, "Starts with pk_live_ or pk_test_"),
    secretKey: z.string().regex(/^sk_(live|test)_[A-Za-z0-9]+$/, "Starts with sk_live_ or sk_test_"),
  })
  .refine((b) => b.publishableKey.slice(3, 7) === b.secretKey.slice(3, 7), "Both keys must be live keys, or both test keys");

/**
 * POST /api/payment-accounts/moyasar (FR-014, design §5.7)
 * The app owner connects THEIR Moyasar account so the app's customers pay them
 * directly. The secret key goes to the app's own backend; it is never returned,
 * logged, or kept by the platform once the backend has it.
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  if (project.owner_id !== user.id) throw new HttpError(403, "forbidden", "Only the owner can connect payments");

  if ((await verifySecretKey(body.secretKey)) === "rejected") {
    throw new HttpError(422, "moyasar_key_rejected", "Moyasar rejected this secret key");
  }
  const mode = body.secretKey.startsWith("sk_live_") ? "live" : "test";
  const admin = adminClient();

  const { data: backend } = await admin
    .from("app_backends")
    .select("id, status, hosting, supabase_project_ref, cell_app_id")
    .eq("project_id", project.id)
    .maybeSingle();
  const ref = backend ? (backend.hosting === "standard" ? backend.supabase_project_ref : backend.cell_app_id) : null;

  let secretStoredAt: string | null = null;
  let pendingSecretId: string | null = null;
  if (backend?.status === "active" && ref) {
    await providerFor(backend.hosting as HostingMode).setSecret(ref as string, "MOYASAR_SECRET_KEY", body.secretKey);
    secretStoredAt = new Date().toISOString();
  } else {
    // the backend is created at the first paid publish; provisioning moves the key there
    const { data: secretId, error } = await admin.rpc("vault_store_secret", {
      p_secret: body.secretKey,
      p_name: `moyasar:${project.id}:${randomUUID()}`,
      p_description: `Moyasar secret key waiting for app ${project.slug}`,
    });
    if (error) throw error;
    pendingSecretId = secretId as string;
  }

  const { data: previous } = await admin.from("app_payment_accounts").select("pending_secret_id").eq("project_id", project.id).maybeSingle();
  const { data, error } = await admin
    .from("app_payment_accounts")
    .upsert(
      {
        project_id: project.id,
        publishable_key: body.publishableKey,
        key_mode: mode,
        status: secretStoredAt ? "active" : "pending",
        secret_stored_at: secretStoredAt,
        pending_secret_id: pendingSecretId,
      },
      { onConflict: "project_id" },
    )
    .select("id, publishable_key, key_mode, status, secret_stored_at")
    .single();
  if (error) throw error;
  if (previous?.pending_secret_id && previous.pending_secret_id !== pendingSecretId) {
    await admin.rpc("vault_delete_secret", { p_secret_id: previous.pending_secret_id });
  }
  return json({ account: data, liveMode: mode === "live" }, 201);
});
