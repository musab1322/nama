/** Errors and types shared by the web app, the worker and the packages (no framework imports). */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export interface OwnedProject {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  status: string;
  current_version_id: string | null;
  vercel_project_id: string | null;
  eas_project_id: string | null;
  app_config: Record<string, unknown>;
}

/** Postgres unique_violation → true */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
