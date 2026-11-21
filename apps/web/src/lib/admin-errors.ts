import { HttpError } from "@/lib/http";

const RPC_ERRORS: Record<string, [number, string]> = {
  forbidden: [403, "Admins only"],
  reason_required: [400, "Give a reason; it is kept in the audit log"],
  project_not_found: [404, "Project not found"],
  report_not_found: [404, "Report not found"],
  not_suspended: [409, "This app is not suspended"],
  invalid_amount: [400, "Amount must be between -10000 and 10000, not 0"],
  insufficient_credits: [409, "The user does not have that many credits"],
  invalid_status: [400, "Invalid status"],
};

export function mapAdminRpcError(err: { message?: string } | null): never {
  const code = Object.keys(RPC_ERRORS).find((k) => err?.message?.includes(k));
  if (code) {
    const [status, message] = RPC_ERRORS[code]!;
    throw new HttpError(status, code, message);
  }
  throw err;
}

/** For ilike filters: strips the characters PostgREST filters treat specially. */
export const searchTerm = (q: string | null) => (q ?? "").replace(/[%_,()*\\]/g, " ").trim().slice(0, 80);
