import { env } from "@banna/shared/env";

/**
 * Supabase Management API — provisions and manages the DEDICATED Supabase
 * project of each generated app (see "Supabase for Platforms" guide).
 */
const API = "https://api.supabase.com";

export class SupabaseMgmtError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function mgmt<T>(path: string, init: { method?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(new URL(path, API), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env().SUPABASE_MANAGEMENT_TOKEN}`,
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const msg = (data as { message?: string }).message ?? `Supabase Management API ${res.status}`;
    throw new SupabaseMgmtError(res.status, msg);
  }
  return data as T;
}

export interface CreatedProject {
  id: string; // project ref
  name: string;
  status: string;
}

export function createProject(opts: { name: string; dbPass: string; regionGroup: string; instanceSize?: string | null }) {
  return mgmt<CreatedProject>("/v1/projects", {
    method: "POST",
    json: {
      name: opts.name,
      organization_slug: env().SUPABASE_APPS_ORG_SLUG,
      db_pass: opts.dbPass,
      region_selection: { type: "smartGroup", code: opts.regionGroup },
      // Omit for the smallest size (Nano scale-to-zero needs Supabase partnership access).
      ...(opts.instanceSize ? { desired_instance_size: opts.instanceSize } : {}),
    },
  });
}

export async function isHealthy(ref: string, services = ["auth", "rest", "db", "storage"]): Promise<boolean> {
  const qs = services.map((s) => `services=${s}`).join("&");
  const health = await mgmt<{ name: string; status: string }[]>(`/v1/projects/${ref}/health?${qs}`);
  return health.length > 0 && health.every((s) => s.status === "ACTIVE_HEALTHY");
}

interface ApiKey {
  type: "publishable" | "secret" | "legacy";
  name: string;
  api_key: string;
}

/** Returns the new-style publishable + secret keys, creating them if the project only has legacy keys. */
export async function ensureApiKeys(ref: string): Promise<{ publishable: string; secret: string }> {
  let keys = await mgmt<ApiKey[]>(`/v1/projects/${ref}/api-keys?reveal=true`);
  if (!keys.some((k) => k.type === "publishable")) {
    await mgmt(`/v1/projects/${ref}/api-keys`, { method: "POST", json: { type: "publishable", name: "default" } });
  }
  if (!keys.some((k) => k.type === "secret")) {
    await mgmt(`/v1/projects/${ref}/api-keys?reveal=true`, {
      method: "POST",
      json: { type: "secret", name: "default", secret_jwt_template: { role: "service_role" } },
    });
  }
  keys = await mgmt<ApiKey[]>(`/v1/projects/${ref}/api-keys?reveal=true`);
  const publishable = keys.find((k) => k.type === "publishable")?.api_key;
  const secret = keys.find((k) => k.type === "secret")?.api_key;
  if (!publishable || !secret) throw new Error("Could not obtain API keys");
  return { publishable, secret };
}

export function updateAuthConfig(ref: string, config: Record<string, unknown>) {
  return mgmt(`/v1/projects/${ref}/config/auth`, { method: "PATCH", json: config });
}

/**
 * Applies SQL. "migrations" (tracked in supabase_migrations, rolled back on failure)
 * needs partner access; "query" is the generally available fallback, wrapped in a transaction.
 */
export async function runMigration(ref: string, name: string, sql: string) {
  if (env().SUPABASE_MIGRATIONS_ENDPOINT === "migrations") {
    await mgmt(`/v1/projects/${ref}/database/migrations`, { method: "POST", json: { name, query: sql } });
  } else {
    await mgmt(`/v1/projects/${ref}/database/query`, { method: "POST", json: { query: `begin;\n${sql}\n;commit;` } });
  }
}

/** Read-only SQL through the Management API; used for aggregate numbers only. */
export function queryRows<T>(ref: string, sql: string) {
  return mgmt<T[]>(`/v1/projects/${ref}/database/query`, { method: "POST", json: { query: sql } });
}

export function securityAdvisors(ref: string) {
  return mgmt<{ lints: { name: string; level: string; detail: string }[] }>(`/v1/projects/${ref}/advisors/security`);
}

/** Deploys a single-file Edge Function (multipart). */
export async function deployFunction(ref: string, slug: string, source: string, verifyJwt = true) {
  const form = new FormData();
  form.append(
    "metadata",
    JSON.stringify({ name: slug, entrypoint_path: "index.ts", verify_jwt: verifyJwt }),
  );
  form.append("file", new Blob([source], { type: "application/typescript" }), "index.ts");
  return mgmt(`/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`, { method: "POST", body: form });
}

export function deleteProject(ref: string) {
  return mgmt(`/v1/projects/${ref}`, { method: "DELETE" });
}

/** Edge Function secrets (e.g. the app owner's Moyasar secret key, FR-014). */
export function setSecrets(ref: string, secrets: { name: string; value: string }[]) {
  return mgmt(`/v1/projects/${ref}/secrets`, { method: "POST", json: secrets });
}

export function pauseProject(ref: string) {
  return mgmt(`/v1/projects/${ref}/pause`, { method: "POST" });
}

export function restoreProject(ref: string) {
  return mgmt(`/v1/projects/${ref}/restore`, { method: "POST" });
}
