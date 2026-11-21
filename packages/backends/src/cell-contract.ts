/**
 * Contract of cell-control, the private admin API of the Saudi cell (design §6, FR-017).
 * The factory reaches it over mTLS only. It never returns end-user data: only ids,
 * states, keys for the app itself, and aggregate numbers.
 *
 *   POST   /cells/apps                       CellCreateRequest   -> CellApp
 *   GET    /cells/apps/{id}                                       -> CellApp
 *   POST   /cells/apps/{id}/configure        CellConfigureRequest -> CellKeys     (idempotent)
 *   POST   /cells/apps/{id}/migrations       CellMigrationRequest -> 204          (idempotent by name)
 *   POST   /cells/apps/{id}/functions        CellFunctionRequest  -> 204
 *   GET    /cells/apps/{id}/security                              -> CellSecurity
 *   POST   /cells/apps/{id}/secrets          CellSecretRequest    -> 204
 *   POST   /cells/apps/{id}/suspend | resume                      -> 204
 *   DELETE /cells/apps/{id}                                       -> 204          (data kept 90 days)
 *   GET    /cells/apps/{id}/stats                                 -> CellStats
 *
 * Errors: JSON { error: { code, message } } with 4xx/5xx. 409 on create means the
 * name exists; the body then carries the existing CellApp so a retried job continues.
 */

export interface CellCreateRequest {
  name: string;
  dbPassword: string;
  /** Resource class inside the cell, e.g. "small". */
  size: string | null;
}

export interface CellApp {
  id: string;
  name: string;
  apiUrl: string;
  status: "creating" | "ready" | "suspended" | "deleting" | "error";
}

export interface CellConfigureRequest {
  siteUrl: string;
  redirectUrls: string[];
}

export interface CellKeys {
  publishable: string;
  secret: string;
}

export interface CellMigrationRequest {
  name: string;
  sql: string;
}

export interface CellFunctionRequest {
  name: string;
  source: string;
  verifyJwt: boolean;
}

export interface CellSecurity {
  /** Blocking findings, e.g. "rls_disabled_in_public:orders". */
  errors: string[];
}

export interface CellSecretRequest {
  name: string;
  value: string;
}

export type { BackendStats as CellStats } from "./provider";
