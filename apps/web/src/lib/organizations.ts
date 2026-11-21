import { HttpError } from "@/lib/http";
export { documentType } from "./documents";

export const ORG_COLUMNS =
  "id, kind, legal_name, license_number, verification_status, donations_eligible, apple_nonprofit_approved, review_note, reviewed_at, created_at, updated_at";

export const ORG_DOCUMENTS_BUCKET = "org-documents";
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const RPC_ERRORS: Record<string, [number, string]> = {
  license_required: [400, "A charity needs its licence number"],
  document_required: [400, "A charity needs its licence document"],
  invalid_document: [400, "Invalid document"],
  forbidden: [403, "Admins only"],
  organization_not_found: [404, "Organization not found"],
  not_reviewable: [409, "This organization is not waiting for this decision"],
  note_required: [400, "Tell the owner why"],
};

export function mapOrgRpcError(err: { message?: string } | null): never {
  const code = Object.keys(RPC_ERRORS).find((k) => err?.message?.includes(k));
  if (code) {
    const [status, message] = RPC_ERRORS[code]!;
    throw new HttpError(status, code, message);
  }
  throw err;
}
