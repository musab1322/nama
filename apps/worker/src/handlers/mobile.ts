import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AscError,
  attachBuild,
  asc,
  ensureAppStoreVersion,
  findAppByBundleId,
  findProcessedBuild,
  mapAppStoreState,
  submitForReview,
  updateVersionLocalization,
} from "@banna/integrations/apple";
import { playAccessToken, playAppExists } from "@banna/integrations/google-play";
import { enqueueJob } from "@banna/shared/jobs";
import { ascCredentialsFor, loadPublisher, playCredentialsFor } from "@banna/integrations/publishers";
import {
  EAS_CLI,
  easEnv,
  materialize,
  parseJsonOutput,
  PermanentError,
  RetryLater,
  run,
  writeSecretFile,
  type JobRow,
  type MobileAppRow,
} from "../support";

type Platform = "ios" | "android";

interface BuildRow {
  id: string;
  project_id: string;
  mobile_app_id: string;
  platform: Platform;
  version_id: string;
  app_version: string;
  build_number: number;
  provider_build_id: string | null;
  runtime_version: string;
  status: string;
}

const APP_COLS = "id, platform, bundle_identifier, display_name, icon_path, store_app_id, publisher_account_id";

async function projectContext(admin: SupabaseClient, projectId: string) {
  const [{ data: project, error: pErr }, { data: apps, error: aErr }, { data: backend }] = await Promise.all([
    admin.from("projects").select("id, slug, eas_project_id").eq("id", projectId).single(),
    admin.from("mobile_apps").select(APP_COLS).eq("project_id", projectId),
    admin.from("app_backends").select("api_url, publishable_key, status").eq("project_id", projectId).maybeSingle(),
  ]);
  if (pErr) throw pErr;
  if (aErr) throw aErr;
  return {
    project: project as { id: string; slug: string; eas_project_id: string | null },
    apps: (apps ?? []) as MobileAppRow[],
    backend:
      backend?.status === "active" && backend.api_url && backend.publishable_key
        ? { api_url: backend.api_url as string, publishable_key: backend.publishable_key as string }
        : null,
  };
}

/** Creates the EAS project (once) under the platform's Expo account and stores its id. */
async function ensureEasProject(admin: SupabaseClient, dir: string, projectId: string): Promise<string> {
  await run("npx", ["--yes", EAS_CLI, "project:init", "--non-interactive", "--force"], { cwd: dir, env: easEnv() });
  const appJson = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as {
    expo: { extra?: { eas?: { projectId?: string } } };
  };
  const easProjectId = appJson.expo.extra?.eas?.projectId;
  if (!easProjectId) throw new Error("eas project:init did not return a project id");
  const { error } = await admin.from("projects").update({ eas_project_id: easProjectId }).eq("id", projectId);
  if (error) throw error;
  return easProjectId;
}

// ---------------------------------------------------------------------------
// mobile.build
// ---------------------------------------------------------------------------
export async function mobileBuild(admin: SupabaseClient, job: JobRow) {
  const buildIds = job.payload.buildIds as string[];
  const { data: builds, error } = await admin.from("mobile_builds").select("*").in("id", buildIds);
  if (error) throw error;
  const pending = (builds as BuildRow[]).filter((b) => b.status === "queued");
  if (!pending.length) return { skipped: true };

  const first = pending[0]!;
  const ctx = await projectContext(admin, first.project_id);
  const buildNumbers = Object.fromEntries(pending.map((b) => [b.platform, b.build_number]));

  let mat = await materialize(admin, {
    projectId: ctx.project.id,
    slug: ctx.project.slug,
    versionId: first.version_id,
    easProjectId: ctx.project.eas_project_id,
    apps: ctx.apps,
    appVersion: first.app_version,
    buildNumbers,
    backend: ctx.backend,
  });
  const secrets: (() => Promise<void>)[] = [];
  try {
    if (!ctx.project.eas_project_id) {
      const easProjectId = await ensureEasProject(admin, mat.dir, ctx.project.id);
      await mat.cleanup();
      mat = await materialize(admin, {
        projectId: ctx.project.id,
        slug: ctx.project.slug,
        versionId: first.version_id,
        easProjectId,
        apps: ctx.apps,
        appVersion: first.app_version,
        buildNumbers,
        backend: ctx.backend,
      });
    }
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: mat.dir, timeoutMs: 15 * 60_000 });

    for (const build of pending) {
      const app = ctx.apps.find((a) => a.id === build.mobile_app_id)!;
      let credEnv: Record<string, string> = {};
      if (build.platform === "ios") {
        // Customer's own Apple account: EAS manages cert + profile in THEIR team via the ASC API key.
        const pub = await loadPublisher(admin, app.publisher_account_id!);
        const creds = await ascCredentialsFor(admin, pub);
        const key = await writeSecretFile("AuthKey.p8", creds.privateKeyP8);
        secrets.push(key.cleanup);
        credEnv = {
          EXPO_ASC_API_KEY_PATH: key.path,
          EXPO_ASC_KEY_ID: creds.keyId,
          EXPO_ASC_ISSUER_ID: creds.issuerId,
          EXPO_APPLE_TEAM_ID: pub.apple_team_id!,
          EXPO_APPLE_TEAM_TYPE: "COMPANY_OR_ORGANIZATION",
        };
      }
      try {
        const out = await run(
          "npx",
          ["--yes", EAS_CLI, "build", "--platform", build.platform, "--profile", "production", "--non-interactive", "--no-wait", "--json"],
          { cwd: mat.dir, env: easEnv(credEnv), timeoutMs: 30 * 60_000 },
        );
        const [eas] = parseJsonOutput<{ id: string }[]>(out.stdout);
        if (!eas) throw new Error("eas build returned no build");
        await admin
          .from("mobile_builds")
          .update({ provider_build_id: eas.id, status: "in_progress", started_at: new Date().toISOString() })
          .eq("id", build.id);
      } catch (err) {
        await admin
          .from("mobile_builds")
          .update({ status: "errored", error_message: err instanceof Error ? err.message.slice(0, 2000) : "failed" })
          .eq("id", build.id);
        throw new PermanentError(`build ${build.platform} failed to start`);
      }
    }
    // Completion arrives through /api/webhooks/eas?event=build.
    return { started: pending.map((b) => b.platform) };
  } finally {
    await mat.cleanup();
    for (const c of secrets) await c();
  }
}

// ---------------------------------------------------------------------------
// mobile.submit — upload the binary to App Store Connect / Google Play
// ---------------------------------------------------------------------------
export async function mobileSubmit(admin: SupabaseClient, job: JobRow) {
  const { data: build, error } = await admin.from("mobile_builds").select("*").eq("id", job.payload.buildId).single();
  if (error) throw error;
  const b = build as BuildRow;
  const ctx = await projectContext(admin, b.project_id);
  const app = ctx.apps.find((a) => a.id === b.mobile_app_id)!;
  const pub = await loadPublisher(admin, app.publisher_account_id!);
  const { data: sub, error: subErr } = await admin
    .from("store_submissions")
    .select("id, status, track")
    .eq("mobile_build_id", b.id)
    .single();
  if (subErr) throw subErr;
  if (!["queued", "awaiting_store_setup", "error"].includes(sub.status as string)) return { already: sub.status };

  const secrets: (() => Promise<void>)[] = [];
  let submitConfig: NonNullable<Parameters<typeof materialize>[1]["submit"]>;
  let credEnv: Record<string, string> = {};

  if (b.platform === "ios") {
    const creds = await ascCredentialsFor(admin, pub);
    // The app record must exist in the customer's App Store Connect (not creatable via API).
    const ascApp = app.store_app_id ? { id: app.store_app_id } : await findAppByBundleId(creds, app.bundle_identifier);
    if (!ascApp) {
      await admin
        .from("store_submissions")
        .update({
          status: "awaiting_store_setup",
          rejection_reason: `Create the app in App Store Connect with bundle ID ${app.bundle_identifier}`,
        })
        .eq("id", sub.id);
      throw new RetryLater("waiting for App Store Connect app record");
    }
    if (!app.store_app_id) await admin.from("mobile_apps").update({ store_app_id: ascApp.id }).eq("id", app.id);
    const key = await writeSecretFile("AuthKey.p8", creds.privateKeyP8);
    secrets.push(key.cleanup);
    submitConfig = {
      ios: { ascAppId: ascApp.id, ascKeyPath: key.path, ascKeyId: creds.keyId, ascIssuerId: creds.issuerId, appleTeamId: pub.apple_team_id! },
    };
    credEnv = { EXPO_ASC_API_KEY_PATH: key.path, EXPO_ASC_KEY_ID: creds.keyId, EXPO_ASC_ISSUER_ID: creds.issuerId };
  } else {
    const saJson = await playCredentialsFor(admin, pub);
    // Play API cannot create a public app; ops (or the customer) creates it once in Play Console.
    if (!(await playAppExists(await playAccessToken(saJson), app.bundle_identifier))) {
      await admin
        .from("store_submissions")
        .update({
          status: "awaiting_store_setup",
          rejection_reason: `Create the app in Google Play Console with package ${app.bundle_identifier}`,
        })
        .eq("id", sub.id);
      throw new RetryLater("waiting for Google Play app");
    }
    const sa = await writeSecretFile("play-service-account.json", saJson);
    secrets.push(sa.cleanup);
    const { data: appRow } = await admin.from("mobile_apps").select("listing_status").eq("id", app.id).single();
    submitConfig = {
      android: {
        serviceAccountKeyPath: sa.path,
        track: sub.track as string,
        // Before the first release is live, Play only accepts draft releases.
        releaseStatus: appRow?.listing_status === "live" ? "completed" : "draft",
      },
    };
  }

  const mat = await materialize(admin, {
    projectId: ctx.project.id,
    slug: ctx.project.slug,
    versionId: b.version_id,
    easProjectId: ctx.project.eas_project_id,
    apps: ctx.apps,
    appVersion: b.app_version,
    buildNumbers: { [b.platform]: b.build_number },
    backend: ctx.backend,
    submit: submitConfig,
  });
  try {
    const out = await run(
      "npx",
      ["--yes", EAS_CLI, "submit", "--platform", b.platform, "--id", b.provider_build_id!, "--profile", "production", "--non-interactive", "--no-wait", "--json"],
      { cwd: mat.dir, env: easEnv(credEnv), timeoutMs: 15 * 60_000 },
    );
    const result = parseJsonOutput<{ id: string } | { id: string }[]>(out.stdout);
    const submissionId = Array.isArray(result) ? result[0]?.id : result.id;
    await admin
      .from("store_submissions")
      .update({ status: "submitting", submit_provider: "eas_submit", provider_submission_id: submissionId, rejection_reason: null })
      .eq("id", sub.id);
    // Completion arrives through /api/webhooks/eas?event=submit.
    return { submissionId };
  } finally {
    await mat.cleanup();
    for (const c of secrets) await c();
  }
}

// ---------------------------------------------------------------------------
// store.request_review — iOS: version + metadata + build → App Review
// ---------------------------------------------------------------------------
export async function requestReview(admin: SupabaseClient, job: JobRow) {
  const { data: sub, error } = await admin
    .from("store_submissions")
    .select("id, platform, status, track, project_id, mobile_build_id, mobile_apps!inner(id, store_app_id, publisher_account_id, full_description, keywords, support_url), mobile_builds!inner(app_version, build_number)")
    .eq("id", job.payload.submissionId)
    .single();
  if (error) throw error;
  if (sub.status !== "submitted") return { skipped: sub.status };

  if (sub.platform === "android") {
    // EAS Submit already created the release on the chosen track; Google reviews it from there.
    const now = new Date().toISOString();
    await admin.from("store_submissions").update({ status: "in_review", review_started_at: now }).eq("id", sub.id);
    if (sub.track === "closed") {
      // the 14-day closed-test clock (FR-006b) starts with the first closed release
      const appId = (sub.mobile_apps as unknown as { id: string }).id;
      await admin.from("mobile_apps").update({ play_closed_test_started_at: now }).eq("id", appId).is("play_closed_test_started_at", null);
    }
    return { platform: "android", track: sub.track };
  }

  const app = sub.mobile_apps as unknown as {
    store_app_id: string; publisher_account_id: string; full_description: string | null; keywords: string | null; support_url: string | null;
  };
  const build = sub.mobile_builds as unknown as { app_version: string; build_number: number };
  const creds = await ascCredentialsFor(admin, await loadPublisher(admin, app.publisher_account_id));

  const processed = await findProcessedBuild(creds, app.store_app_id, build.build_number);
  if (!processed) throw new RetryLater("Apple is still processing the build");

  const version = await ensureAppStoreVersion(creds, app.store_app_id, build.app_version);
  await attachBuild(creds, version.id, processed.id);
  await updateVersionLocalization(creds, version.id, {
    description: app.full_description ?? undefined,
    keywords: app.keywords ?? undefined,
    supportUrl: app.support_url ?? undefined,
  });

  try {
    await submitForReview(creds, app.store_app_id, version.id);
  } catch (err) {
    if (err instanceof AscError && err.status === 409) {
      // Usually missing screenshots, App Privacy answers or age rating — must be completed in App Store Connect.
      await admin
        .from("store_submissions")
        .update({ status: "awaiting_store_setup", store_version_id: version.id, rejection_reason: err.message })
        .eq("id", sub.id);
      throw new RetryLater(`App Store Connect setup incomplete: ${err.message}`);
    }
    throw err;
  }

  await admin
    .from("store_submissions")
    .update({ status: "in_review", store_version_id: version.id, review_started_at: new Date().toISOString(), rejection_reason: null })
    .eq("id", sub.id);
  await enqueueJob(admin, "store.poll_status", { submissionId: sub.id }, {
    projectId: sub.project_id as string,
    dedupeKey: `store.poll:${sub.id}`,
    runAfter: new Date(Date.now() + 30 * 60_000),
    maxAttempts: 50,
  });
  return { versionId: version.id };
}

// ---------------------------------------------------------------------------
// store.poll_status — iOS review tracker (App Store Connect webhooks can replace this)
// ---------------------------------------------------------------------------
export async function pollStoreStatus(admin: SupabaseClient, job: JobRow) {
  const { data: sub, error } = await admin
    .from("store_submissions")
    .select("id, status, store_version_id, mobile_build_id, mobile_apps!inner(id, store_app_id, publisher_account_id), mobile_builds!inner(runtime_version)")
    .eq("id", job.payload.submissionId)
    .single();
  if (error) throw error;
  if (!sub.store_version_id || ["published", "rejected", "removed"].includes(sub.status as string)) return { done: true };

  const app = sub.mobile_apps as unknown as { id: string; store_app_id: string; publisher_account_id: string };
  const creds = await ascCredentialsFor(admin, await loadPublisher(admin, app.publisher_account_id));
  const v = await asc<{ data: { attributes: { appStoreState?: string; appVersionState?: string } } }>(
    creds,
    `/v1/appStoreVersions/${sub.store_version_id}`,
  );
  const state = v.data.attributes.appVersionState ?? v.data.attributes.appStoreState ?? "";
  const mapped = mapAppStoreState(state);

  if (mapped && mapped !== sub.status) {
    const now = new Date().toISOString();
    await admin
      .from("store_submissions")
      .update({
        status: mapped,
        ...(mapped === "approved" ? { reviewed_at: now } : {}),
        ...(mapped === "published"
          ? { published_at: now, store_url: `https://apps.apple.com/app/id${app.store_app_id}` }
          : {}),
        ...(mapped === "rejected" ? { reviewed_at: now, rejection_reason: `App Review: ${state}. See Resolution Center.` } : {}),
      })
      .eq("id", sub.id);
    if (mapped === "published") {
      const runtime = (sub.mobile_builds as unknown as { runtime_version: string }).runtime_version;
      await admin
        .from("mobile_apps")
        .update({ listing_status: "live", native_runtime_version: runtime, store_url: `https://apps.apple.com/app/id${app.store_app_id}` })
        .eq("id", app.id);
    }
  }
  if (mapped === "published" || mapped === "rejected" || mapped === "removed") return { final: mapped };
  throw new RetryLater(`still ${state}`);
}

// ---------------------------------------------------------------------------
// mobile.ota — EAS Update to the production channel
// ---------------------------------------------------------------------------
export async function mobileOta(admin: SupabaseClient, job: JobRow) {
  const { data: rel, error } = await admin.from("ota_releases").select("*").eq("id", job.payload.releaseId).single();
  if (error) throw error;
  if (rel.status !== "pending") return { skipped: rel.status };
  await admin.from("ota_releases").update({ status: "uploading" }).eq("id", rel.id);

  const ctx = await projectContext(admin, rel.project_id as string);
  if (!ctx.project.eas_project_id) throw new PermanentError("project has no EAS project");
  const mat = await materialize(admin, {
    projectId: ctx.project.id,
    slug: ctx.project.slug,
    versionId: rel.version_id as string,
    easProjectId: ctx.project.eas_project_id,
    apps: ctx.apps,
    appVersion: "1.0.0", // ignored by the fingerprint runtime policy
    buildNumbers: {},
    backend: ctx.backend,
  });
  try {
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: mat.dir, timeoutMs: 15 * 60_000 });
    const platforms = rel.platforms as Platform[];
    const args = [
      "--yes", EAS_CLI, "update",
      "--channel", rel.channel as string,
      "--platform", platforms.length === 2 ? "all" : platforms[0]!,
      "--message", (rel.message as string) ?? "update",
      "--non-interactive", "--json",
    ];
    if ((rel.rollout_percentage as number) < 100) args.push("--rollout-percentage", String(rel.rollout_percentage));
    const out = await run("npx", args, { cwd: mat.dir, env: { ...easEnv(), ...mat.env }, timeoutMs: 20 * 60_000 });
    const updates = parseJsonOutput<{ group: string; runtimeVersion: string; platform: string }[]>(out.stdout);

    // Safety net: an update on a runtime no store binary has reaches nobody — report it instead of "published".
    const wrongRuntime = updates.find((u) => u.runtimeVersion !== rel.runtime_version);
    await admin
      .from("ota_releases")
      .update({
        status: wrongRuntime ? "failed" : "published",
        provider_update_group_id: updates[0]?.group ?? null,
        error_message: wrongRuntime
          ? `Runtime ${wrongRuntime.runtimeVersion} ≠ store runtime ${rel.runtime_version}: a new store build is required`
          : null,
        published_at: wrongRuntime ? null : new Date().toISOString(),
      })
      .eq("id", rel.id);
    return { group: updates[0]?.group };
  } catch (err) {
    await admin
      .from("ota_releases")
      .update({ status: "failed", error_message: err instanceof Error ? err.message.slice(0, 2000) : "failed" })
      .eq("id", rel.id);
    throw new PermanentError("eas update failed");
  } finally {
    await mat.cleanup();
  }
}
