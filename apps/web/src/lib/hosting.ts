import { HttpError } from "@/lib/http";

export const HOSTING_COLUMNS = "id, project_id, region, status, setup_fee_halalas, monthly_fee_halalas, note, created_at, updated_at";

const RPC_ERRORS: Record<string, [number, string]> = {
  project_not_found: [404, "Project not found"],
  request_not_found: [404, "Request not found"],
  already_saudi: [409, "This app is already hosted in Saudi Arabia"],
  not_payable: [409, "This request has no price to pay yet"],
  not_cancelable: [409, "A paid request is canceled by our team, with a refund"],
  not_quotable: [409, "This request cannot be quoted now"],
  invalid_quote: [400, "Setup fee must be at least 1 SAR and the monthly fee 0 or more"],
  forbidden: [403, "Admins only"],
};

export function mapHostingRpcError(err: { message?: string } | null): never {
  const code = Object.keys(RPC_ERRORS).find((k) => err?.message?.includes(k));
  if (code) {
    const [status, message] = RPC_ERRORS[code]!;
    throw new HttpError(status, code, message);
  }
  throw err;
}
