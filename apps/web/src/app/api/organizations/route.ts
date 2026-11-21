import { randomUUID } from "node:crypto";
import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { HttpError, json, requireUser, route } from "@/lib/http";
import { MAX_DOCUMENT_BYTES, ORG_COLUMNS, ORG_DOCUMENTS_BUCKET, documentType, mapOrgRpcError } from "@/lib/organizations";

export const runtime = "nodejs";

const Fields = z.object({
  kind: z.enum(["business", "charity"]),
  legalName: z.string().trim().min(2).max(200),
  licenseNumber: z.string().trim().max(60).optional(),
});

/** GET /api/organizations: the account's organization (or null) and its review state. */
export const GET = route(async () => {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("organizations").select(ORG_COLUMNS).maybeSingle();
  if (error) throw error;
  return json({ organization: data });
});

/**
 * POST /api/organizations (FR-012c, design §5.6). multipart/form-data:
 * kind, legalName, licenseNumber, document (PDF/PNG/JPEG up to 5 MB).
 * A charity goes to "pending" until an admin verifies it; then the charity price
 * applies from the next payment or renewal. Changing the facts later needs a new review.
 */
export const POST = route(async (req) => {
  const { user } = await requireUser();
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new HttpError(400, "invalid_request", "Send multipart/form-data");
  }
  const fields = Fields.parse({
    kind: form.get("kind"),
    legalName: form.get("legalName"),
    licenseNumber: form.get("licenseNumber") || undefined,
  });
  const admin = adminClient();

  let documentPath: string | null = null;
  const file = form.get("document");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_DOCUMENT_BYTES) throw new HttpError(413, "document_too_large", "The document is larger than 5 MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = documentType(bytes);
    if (!type) throw new HttpError(415, "document_type", "Upload a PDF, PNG or JPEG");
    documentPath = `${user.id}/${randomUUID()}.${type.ext}`;
    const { error } = await admin.storage.from(ORG_DOCUMENTS_BUCKET).upload(documentPath, bytes, { contentType: type.mime });
    if (error) throw error;
  }

  const { data: id, error } = await admin.rpc("submit_organization", {
    p_user_id: user.id,
    p_kind: fields.kind,
    p_legal_name: fields.legalName,
    p_license: fields.licenseNumber ?? null,
    p_document_path: documentPath,
  });
  if (error) {
    if (documentPath) await admin.storage.from(ORG_DOCUMENTS_BUCKET).remove([documentPath]).catch(() => undefined);
    mapOrgRpcError(error);
  }
  const { data: organization, error: readError } = await admin.from("organizations").select(ORG_COLUMNS).eq("id", id as string).single();
  if (readError) throw readError;
  return json({ organization }, 201);
});
