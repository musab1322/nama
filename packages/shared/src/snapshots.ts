import { gunzipSync, gzipSync } from "node:zlib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256 } from "./crypto";

/** A generated app = flat map of POSIX paths → UTF-8 file contents. */
export type ProjectFiles = Record<string, string>;

export const SOURCES_BUCKET = "project-sources";
export const TEMPLATE_PATH = "templates/expo-base/current.json.gz";

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_PROJECT_BYTES = 20 * 1024 * 1024;

/**
 * Files the platform owns. The AI may read them but never write them:
 * they decide the native binary (and therefore whether OTA is allowed),
 * or they wire the app to its dedicated backend.
 */
const LOCKED_PATTERNS: RegExp[] = [
  /^package(-lock)?\.json$/,
  /^app\.json$/,
  /^app\.config\.(js|ts|mjs|cjs)$/,
  /^eas\.json$/,
  /^(babel|metro)\.config\.(js|cjs|mjs|ts)$/,
  /^tsconfig\.json$/,
  /^(ios|android)\//,
  /^plugins\//,
  // platform-owned app code (the Expo starter keeps sources under src/; older apps at the root)
  /^(src\/)?lib\/supabase\.ts$/,
  /^(src\/)?lib\/(preview\/|privacy\.ts$|payments\.ts$|updates\.ts$)/,
  /^(src\/)?app\/privacy\.tsx$/,
  /^(src\/)?components\/PrivacyConsent\.tsx$/,
  /^supabase\//, // backend SQL is written by the platform from backend_migrations
  /^\./, // dotfiles (.env, .npmrc, .github …)
];

/** Files that affect the native build. Any change here = new store binary. */
const NATIVE_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^app\.json$/,
  /^app\.config\.(js|ts|mjs|cjs)$/,
  /^(ios|android)\//,
  /^plugins\//,
];

export function normalizePath(input: string): string {
  const p = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (p.length === 0 || p.length > 300) throw new Error(`invalid path length: ${input}`);
  if (p.startsWith("/") || p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
    throw new Error(`invalid path: ${input}`);
  }
  if (!/^[A-Za-z0-9_\-./()[\]@+]+$/.test(p)) throw new Error(`invalid characters in path: ${input}`);
  return p;
}

export const isLockedPath = (p: string) => LOCKED_PATTERNS.some((re) => re.test(p));

export function contentHash(files: ProjectFiles): string {
  const manifest = Object.keys(files)
    .sort()
    .map((p) => `${p}\0${sha256(files[p] ?? "")}`)
    .join("\n");
  return sha256(manifest);
}

/**
 * Conservative native fingerprint: hash of every native-affecting file.
 * If it differs from the live store build, the change is NOT shipped over OTA.
 * (EAS also computes its own fingerprint runtimeVersion at build/update time —
 * the worker double-checks against it.)
 */
export function nativeFingerprint(files: ProjectFiles): string {
  const native = Object.keys(files)
    .filter((p) => NATIVE_PATTERNS.some((re) => re.test(p)))
    .sort()
    .map((p) => `${p}\0${sha256(files[p] ?? "")}`)
    .join("\n");
  return sha256(`native-v1\n${native}`);
}

export function fileManifest(files: ProjectFiles) {
  return Object.keys(files)
    .sort()
    .map((path) => ({ path, size: Buffer.byteLength(files[path] ?? "", "utf8"), sha256: sha256(files[path] ?? "") }));
}

export function assertWithinLimits(files: ProjectFiles) {
  let total = 0;
  for (const [p, c] of Object.entries(files)) {
    const size = Buffer.byteLength(c, "utf8");
    if (size > MAX_FILE_BYTES) throw new Error(`file too large: ${p}`);
    total += size;
  }
  if (total > MAX_PROJECT_BYTES) throw new Error("project exceeds size limit");
}

export const snapshotPath = (projectId: string, versionId: string) => `${projectId}/${versionId}.json.gz`;

export async function saveSnapshot(admin: SupabaseClient, path: string, files: ProjectFiles) {
  const body = gzipSync(Buffer.from(JSON.stringify(files), "utf8"));
  const { error } = await admin.storage
    .from(SOURCES_BUCKET)
    .upload(path, body, { contentType: "application/gzip", upsert: false });
  if (error) throw error;
}

export async function loadSnapshot(admin: SupabaseClient, path: string): Promise<ProjectFiles> {
  const { data, error } = await admin.storage.from(SOURCES_BUCKET).download(path);
  if (error) throw error;
  const buf = Buffer.from(await data.arrayBuffer());
  return JSON.parse(gunzipSync(buf).toString("utf8")) as ProjectFiles;
}

/** Base Expo template (built by scripts/build-template.ts). Empty map if not uploaded yet. */
export async function loadTemplate(admin: SupabaseClient): Promise<ProjectFiles> {
  try {
    return await loadSnapshot(admin, TEMPLATE_PATH);
  } catch {
    return {};
  }
}

export async function loadVersionFiles(admin: SupabaseClient, versionId: string) {
  const { data, error } = await admin
    .from("project_versions")
    .select("id, project_id, version_number, storage_path, native_fingerprint, content_hash")
    .eq("id", versionId)
    .single();
  if (error) throw error;
  const files = await loadSnapshot(admin, data.storage_path as string);
  return { version: data, files };
}
