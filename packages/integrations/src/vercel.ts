import { env } from "@banna/shared/env";
import { sha1 } from "@banna/shared/crypto";
import type { ProjectFiles } from "@banna/shared/snapshots";

const API = "https://api.vercel.com";

export class VercelError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function vercel<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const e = env();
  const url = new URL(path, API);
  url.searchParams.set("teamId", e.VERCEL_TEAM_ID);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${e.VERCEL_TOKEN}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(url, { ...init, headers, body });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } }).error;
    throw new VercelError(res.status, err?.code ?? "vercel_error", err?.message ?? `Vercel ${res.status}`);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export interface VercelProject {
  id: string;
  name: string;
}

/** One Vercel project per generated app (needed for per-app domains and env vars). */
export function createProject(name: string) {
  return vercel<VercelProject>("/v11/projects", {
    method: "POST",
    json: {
      name,
      framework: null,
      buildCommand: "npx expo export --platform web",
      outputDirectory: "dist",
      installCommand: "npm ci --no-audit --no-fund",
      // Previews are embedded in the builder (iframe) and opened by QR on phones,
      // so Vercel Authentication must be off for these generated-app projects.
      ssoProtection: null,
    },
  });
}

export function upsertEnv(
  projectId: string,
  vars: { key: string; value: string; sensitive?: boolean }[],
  targets: ("production" | "preview")[] = ["production", "preview"],
) {
  return vercel(`/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, {
    method: "POST",
    json: vars.map((v) => ({
      key: v.key,
      value: v.value,
      type: v.sensitive ? "sensitive" : "plain",
      target: targets,
    })),
  });
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------
async function uploadFile(content: Buffer, digest: string) {
  await vercel("/v2/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-vercel-digest": digest,
      "Content-Length": String(content.length),
    },
    body: new Uint8Array(content),
  });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

export interface VercelDeployment {
  id: string;
  url: string;
  inspectorUrl?: string;
  readyState: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
}

/**
 * Uploads files by SHA1 (Vercel skips content it already has) then creates the deployment.
 * Vercel runs the build (`expo export --platform web`) on its side.
 */
export async function createDeployment(opts: {
  vercelProjectId: string;
  name: string;
  files: ProjectFiles;
  target: "production" | "preview";
  meta: Record<string, string>;
}): Promise<VercelDeployment> {
  const entries = Object.entries(opts.files).map(([file, content]) => {
    const buf = Buffer.from(content, "utf8");
    return { file, buf, sha: sha1(buf) };
  });
  await mapLimit(entries, 8, (e) => uploadFile(e.buf, e.sha));

  return vercel<VercelDeployment>("/v13/deployments?skipAutoDetectionConfirmation=1", {
    method: "POST",
    json: {
      name: opts.name,
      project: opts.vercelProjectId,
      target: opts.target,
      files: entries.map((e) => ({ file: e.file, sha: e.sha, size: e.buf.length })),
      meta: opts.meta,
    },
  });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------
export interface ProjectDomain {
  name: string;
  apexName: string;
  verified: boolean;
  redirect?: string | null;
  verification?: { type: string; domain: string; value: string; reason: string }[];
}

export function addProjectDomain(projectId: string, name: string, redirect?: string) {
  return vercel<ProjectDomain>(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: "POST",
    json: redirect ? { name, redirect, redirectStatusCode: 308 } : { name },
  });
}

export function verifyProjectDomain(projectId: string, name: string) {
  return vercel<ProjectDomain>(
    `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}/verify`,
    { method: "POST" },
  );
}

/** Removes an app's web project and all its deployments (account deletion). 404 counts as done. */
export async function deleteProject(projectId: string) {
  try {
    await vercel(`/v9/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof VercelError && err.status === 404) return;
    throw err;
  }
}

export function removeProjectDomain(projectId: string, name: string) {
  return vercel(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export interface DomainConfig {
  misconfigured: boolean;
  recommendedIPv4?: { rank: number; value: string[] }[];
  recommendedCNAME?: { rank: number; value: string }[];
}

export function getDomainConfig(name: string) {
  return vercel<DomainConfig>(`/v6/domains/${encodeURIComponent(name)}/config`);
}
