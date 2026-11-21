import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@banna/shared/env";
import { loadVersionFiles, normalizePath, type ProjectFiles } from "@banna/shared/snapshots";
import { appPublicEnv } from "@banna/integrations/app-env";

/** Pinned so builds are reproducible; bump deliberately. */
export const EAS_CLI = "eas-cli@27.11.0";

/** Not a failure: try again later with backoff (e.g. "Apple is still processing the build"). */
export class RetryLater extends Error {}
/** Will never succeed without a human (bad credentials, policy block). */
export class PermanentError extends Error {}

export interface JobRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  project_id: string | null;
  attempts: number;
  max_attempts: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** spawn without a shell — arguments are never interpolated into a command line. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, CI: "1", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 20 * 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/** eas-cli with --json prints JSON on stdout; tolerate log lines before it. */
export function parseJsonOutput<T>(stdout: string): T {
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in eas output: ${stdout.slice(0, 500)}`);
  return JSON.parse(stdout.slice(start)) as T;
}

export const easEnv = (extra: Record<string, string | undefined> = {}) => ({
  EXPO_TOKEN: env().EXPO_TOKEN,
  EAS_NO_VCS: "1", // the directory is not a git repo
  EAS_BUILD_NO_EXPO_GO_WARNING: "1",
  ...extra,
});

export interface MobileAppRow {
  id: string;
  platform: "ios" | "android";
  bundle_identifier: string;
  display_name: string;
  icon_path: string | null;
  store_app_id: string | null;
  publisher_account_id: string | null;
}

export interface MaterializeOptions {
  projectId: string;
  slug: string;
  versionId: string;
  easProjectId: string | null;
  apps: MobileAppRow[];
  appVersion: string;
  buildNumbers: Partial<Record<"ios" | "android", number>>;
  backend: { api_url: string; publishable_key: string } | null;
  submit?: {
    ios?: { ascAppId: string; ascKeyPath: string; ascKeyId: string; ascIssuerId: string; appleTeamId: string };
    android?: { serviceAccountKeyPath: string; track: string; releaseStatus: "draft" | "completed" };
  };
}

/**
 * Writes the version's files to a temp dir and renders the platform-owned
 * app.json + eas.json from the store identity. The AI never controls these.
 */
export async function materialize(admin: SupabaseClient, o: MaterializeOptions) {
  const dir = await mkdtemp(join(tmpdir(), `app-${o.slug}-`));
  const { files } = await loadVersionFiles(admin, o.versionId);
  await writeFiles(dir, files);

  const ios = o.apps.find((a) => a.platform === "ios");
  const android = o.apps.find((a) => a.platform === "android");
  const primary = ios ?? android;
  if (!primary) throw new PermanentError("no mobile app identity");

  // Store icon (1024×1024) from the user's assets bucket.
  if (primary.icon_path) {
    const { data, error } = await admin.storage.from("project-assets").download(primary.icon_path);
    if (error) throw error;
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "store-icon.png"), Buffer.from(await data.arrayBuffer()));
  }

  const base = files["app.json"] ? (JSON.parse(files["app.json"]) as { expo?: Record<string, unknown> }) : {};
  const expo: Record<string, unknown> = {
    ...(base.expo ?? {}),
    name: primary.display_name,
    slug: o.slug,
    owner: env().EXPO_OWNER,
    version: o.appVersion,
    scheme: o.slug.replace(/[^a-z0-9]/g, ""),
    icon: primary.icon_path ? "./assets/store-icon.png" : (base.expo?.icon ?? undefined),
    runtimeVersion: { policy: "fingerprint" },
    ...(o.easProjectId
      ? {
          updates: { url: `https://u.expo.dev/${o.easProjectId}`, checkAutomatically: "ON_LOAD", fallbackToCacheTimeout: 0 },
          extra: { ...((base.expo?.extra as object) ?? {}), eas: { projectId: o.easProjectId } },
        }
      : {}),
    ios: {
      ...((base.expo?.ios as object) ?? {}),
      bundleIdentifier: ios?.bundle_identifier ?? primary.bundle_identifier,
      buildNumber: String(o.buildNumbers.ios ?? 1),
      config: { usesNonExemptEncryption: false },
    },
    android: {
      ...((base.expo?.android as object) ?? {}),
      package: android?.bundle_identifier ?? primary.bundle_identifier,
      versionCode: o.buildNumbers.android ?? 1,
    },
  };
  await writeFile(join(dir, "app.json"), JSON.stringify({ expo }, null, 2));

  const buildEnv: Record<string, string> = {
    ...(await appPublicEnv(admin, o.projectId)),
    ...(o.backend ? { EXPO_PUBLIC_SUPABASE_URL: o.backend.api_url, EXPO_PUBLIC_SUPABASE_KEY: o.backend.publishable_key } : {}),
  };
  const easJson = {
    cli: { version: ">= 27.0.0", appVersionSource: "local" },
    build: { production: { channel: "production", autoIncrement: false, env: buildEnv } },
    submit: {
      production: {
        ...(o.submit?.ios
          ? {
              ios: {
                ascAppId: o.submit.ios.ascAppId,
                ascApiKeyPath: o.submit.ios.ascKeyPath,
                ascApiKeyId: o.submit.ios.ascKeyId,
                ascApiKeyIssuerId: o.submit.ios.ascIssuerId,
                appleTeamId: o.submit.ios.appleTeamId,
              },
            }
          : {}),
        ...(o.submit?.android ? { android: o.submit.android } : {}),
      },
    },
  };
  await writeFile(join(dir, "eas.json"), JSON.stringify(easJson, null, 2));

  return { dir, env: buildEnv, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writeFiles(root: string, files: ProjectFiles) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, normalizePath(rel)); // re-validated: no traversal outside root
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

/**
 * Writes a secret to a 0600 file in its OWN temp dir, never inside the project
 * dir: `eas build` uploads the project directory to Expo's servers.
 */
export async function writeSecretFile(name: string, content: string) {
  const dir = await mkdtemp(join(tmpdir(), "secret-"));
  const path = join(dir, name);
  await writeFile(path, content, { mode: 0o600 });
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
