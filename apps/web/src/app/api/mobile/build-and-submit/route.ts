import { z } from "zod";
import { adminClient } from "@banna/shared/supabase-admin";
import { env } from "@banna/shared/env";
import { HttpError, json, parseBody, requireOwnedProject, requireUser, route } from "@/lib/http";
import { enqueueJob } from "@banna/shared/jobs";
import { moderateForStore } from "@banna/generator/moderation";
import { claimPublishSlot, ensureBackend } from "@banna/backends/ensure";
import { loadVersionFiles, nativeFingerprint } from "@banna/shared/snapshots";

export const runtime = "nodejs";
export const maxDuration = 120;

const Platform = z.enum(["ios", "android"]);
type Platform = z.infer<typeof Platform>;

const Body = z.object({
  projectId: z.string().uuid(),
  platforms: z.array(Platform).min(1).max(2),
  /** Store Metadata Wizard */
  listing: z.object({
    displayName: z.string().trim().min(2).max(30),
    subtitle: z.string().trim().max(30).optional(),
    shortDescription: z.string().trim().min(10).max(80),
    fullDescription: z.string().trim().min(50).max(4000),
    keywords: z.string().trim().max(100).optional(),
    category: z.string().trim().min(2).max(60),
    privacyPolicyUrl: z.string().url().startsWith("https://").optional(),
    supportUrl: z.string().url().startsWith("https://").optional(),
    iconPath: z.string().min(3).max(300), // in bucket project-assets, 1024x1024 PNG without alpha
  }),
  iosPublisherAccountId: z.string().uuid().optional(),
  androidPublisherAccountId: z.string().uuid().optional(),
  tracks: z
    .object({
      ios: z.enum(["testflight", "app_store"]).default("app_store"),
      android: z.enum(["internal", "closed", "open", "production"]).default("production"),
    })
    .default({ ios: "app_store", android: "production" }),
});

function bundleIdFor(slug: string): string {
  let tail = slug.replace(/[^a-z0-9]/g, "");
  if (!/^[a-z]/.test(tail)) tail = `a${tail}`;
  return `${env().BUNDLE_ID_PREFIX}.${tail}`.slice(0, 150);
}

const bumpPatch = (v: string) => {
  const [maj, min, pat] = v.split(".").map(Number);
  return `${maj}.${min}.${(pat ?? 0) + 1}`;
};

/**
 * POST /api/mobile/build-and-submit
 * 1-click publish: validates entitlement + listing, moderates the app, creates
 * the store identities, inserts queued builds and hands off to the worker
 * (EAS Build → webhook → EAS Submit → App Review).
 */
export const POST = route(async (req) => {
  const { user, supabase } = await requireUser();
  const body = await parseBody(req, Body);
  const project = await requireOwnedProject(supabase, body.projectId);
  const admin = adminClient();
  const platforms = [...new Set(body.platforms)];

  if (!project.current_version_id) throw new HttpError(409, "nothing_to_build", "Generate the app first");
  if (!body.listing.iconPath.startsWith(`${project.id}/`)) throw new HttpError(400, "invalid_icon", "Upload the icon first");

  // ---- entitlement (subscription or one-time store fee) -----------------
  const { data: allowed, error: entErr } = await supabase.rpc("can_publish_to_stores", { p_project_id: project.id });
  if (entErr) throw entErr;
  if (!allowed) throw new HttpError(402, "store_publishing_locked", "Upgrade or pay the store publishing fee");

  // ---- backend must be live before an app with login ships --------------
  // created on the first paid publish (NFR-007); the owner retries once it is ready
  await claimPublishSlot(admin, project.id, project.owner_id);
  const backend = await ensureBackend(admin, project);
  if (backend.state === "provisioning") {
    throw new HttpError(409, "backend_not_ready", "The app's database is being prepared (1-3 minutes). Try again shortly.");
  }

  // ---- one pipeline at a time -------------------------------------------
  const { count: inflight } = await admin
    .from("mobile_builds")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .in("status", ["queued", "in_progress"]);
  if (inflight) throw new HttpError(409, "build_in_progress", "A build is already running");

  // ---- publishers --------------------------------------------------------
  const publisherFor: Partial<Record<Platform, string>> = {};
  if (platforms.includes("ios")) {
    const { data: pub } = await supabase
      .from("publisher_accounts")
      .select("id, status")
      .eq("platform", "ios")
      .eq("status", "verified")
      .match(body.iosPublisherAccountId ? { id: body.iosPublisherAccountId } : {})
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!pub) {
      throw new HttpError(409, "apple_account_required", "Connect your Apple Developer account to publish on iOS");
    }
    publisherFor.ios = pub.id as string;
  }
  // Android publishes under the customer's own Play account only (FR-006a).
  let androidTrack = body.tracks.android;
  let closedTestNotice = false;
  if (platforms.includes("android")) {
    const { data: own } = await supabase
      .from("publisher_accounts")
      .select("id")
      .eq("platform", "android")
      .eq("status", "verified")
      .match(body.androidPublisherAccountId ? { id: body.androidPublisherAccountId } : {})
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!own) throw new HttpError(409, "google_account_required", "Connect your Google Play developer account to publish on Android");
    publisherFor.android = own.id as string;

    // New personal Play accounts must pass a 14-day closed test with 12+ testers first (FR-006b).
    const { data: needsClosed, error: rpcErr } = await supabase.rpc("play_needs_closed_test", { p_publisher_id: own.id });
    if (rpcErr) throw rpcErr;
    if (needsClosed && (androidTrack === "production" || androidTrack === "open")) {
      androidTrack = "closed";
      closedTestNotice = true;
    }
  }

  // ---- moderation (protects every account the app is published under) ---
  const { files } = await loadVersionFiles(admin, project.current_version_id);
  const { data: existingApps } = await admin
    .from("mobile_apps")
    .select("id, platform, listing_status, full_description")
    .eq("project_id", project.id);
  const approvedDescription =
    existingApps?.find((a) => a.listing_status === "live")?.full_description as string | undefined;
  const verdict = await moderateForStore({
    kind: "store_submission",
    appName: body.listing.displayName,
    description: body.listing.fullDescription,
    approvedDescription: approvedDescription ?? null,
    screensSummary: Object.keys(files).filter((p) => p.startsWith("app/") || p.startsWith("components/")).join("\n"),
  });
  if (!verdict.allowed) {
    throw new HttpError(422, "store_policy_violation", "This app can't be submitted to the stores", verdict);
  }

  const privacyPolicyUrl =
    body.listing.privacyPolicyUrl ?? `https://${project.slug}.${env().PLATFORM_ROOT_DOMAIN}/privacy`;
  const supportUrl = body.listing.supportUrl ?? `https://${project.slug}.${env().PLATFORM_ROOT_DOMAIN}/support`;
  const fingerprint = nativeFingerprint(files);
  const builds = [];

  for (const platform of platforms) {
    // ---- store identity (bundle id is permanent once used) ---------------
    const listing = {
      display_name: body.listing.displayName,
      subtitle: body.listing.subtitle ?? null,
      short_description: body.listing.shortDescription,
      full_description: body.listing.fullDescription,
      keywords: body.listing.keywords ?? null,
      category: body.listing.category,
      privacy_policy_url: privacyPolicyUrl,
      support_url: supportUrl,
      icon_path: body.listing.iconPath,
      publisher_account_id: publisherFor[platform],
    };
    let app = existingApps?.find((a) => a.platform === platform);
    if (app) {
      const { error } = await admin.from("mobile_apps").update(listing).eq("id", app.id);
      if (error) throw error;
    } else {
      const { data, error } = await admin
        .from("mobile_apps")
        .insert({ project_id: project.id, platform, bundle_identifier: bundleIdFor(project.slug), ...listing })
        .select("id, platform, listing_status, full_description")
        .single();
      if (error) throw error;
      app = data;
    }

    // ---- marketing version ------------------------------------------------
    const { data: last } = await admin
      .from("mobile_builds")
      .select("app_version, store_submissions(status)")
      .eq("mobile_app_id", app!.id)
      .order("build_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastVersion = (last?.app_version as string | undefined) ?? null;
    const released = ((last?.store_submissions as { status: string }[] | undefined) ?? []).some((s) =>
      ["approved", "published"].includes(s.status),
    );
    const appVersion = !lastVersion ? "1.0.0" : released ? bumpPatch(lastVersion) : lastVersion;

    const { data: build, error: buildErr } = await admin
      .from("mobile_builds")
      .insert({
        project_id: project.id,
        mobile_app_id: app!.id,
        platform,
        version_id: project.current_version_id,
        app_version: appVersion,
        build_number: 1, // assigned by trigger
        runtime_version: "pending", // set from EAS (fingerprint policy) when the build finishes
        native_fingerprint: fingerprint,
        status: "queued",
        triggered_by: user.id,
      })
      .select("id, platform, app_version, build_number, status")
      .single();
    if (buildErr) throw buildErr;

    // The submission row exists from the start so the Review Tracker can show the whole pipeline.
    const { error: subErr } = await admin.from("store_submissions").insert({
      project_id: project.id,
      mobile_app_id: app!.id,
      mobile_build_id: build.id,
      platform,
      track: platform === "ios" ? body.tracks.ios : androidTrack,
      status: "queued",
    });
    if (subErr) throw subErr;
    builds.push(build);
  }

  await enqueueJob(
    admin,
    "mobile.build",
    { buildIds: builds.map((b) => b.id) },
    { projectId: project.id, dedupeKey: `mobile.build:${project.id}` },
  );

  return json({ builds, moderation: { risk: verdict.risk }, androidTrack, closedTestRequired: closedTestNotice }, 202);
});
