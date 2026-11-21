import { createPrivateKey, sign } from "node:crypto";
import { base64url } from "@banna/shared/crypto";

/**
 * App Store Connect API client for the CUSTOMER's own Apple account
 * (each iOS app is published under its owner's developer account — Guideline 4.2.6).
 */
export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyP8: string;
}

const API = "https://api.appstoreconnect.apple.com";

export class AscError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errors: unknown[] = [],
  ) {
    super(message);
  }
}

/** ES256 JWT, valid 20 minutes (Apple's maximum). */
export function ascToken(c: AscCredentials, now = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: c.keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: c.issuerId, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(c.privateKeyP8),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function asc<T = { data: unknown }>(
  c: AscCredentials,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<T> {
  const res = await fetch(new URL(path, API), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${ascToken(c)}`,
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  if (res.status === 204) return {} as T;
  const data = (await res.json().catch(() => ({}))) as { errors?: { detail?: string; title?: string }[] };
  if (!res.ok) {
    const first = data.errors?.[0];
    throw new AscError(res.status, first?.detail ?? first?.title ?? `App Store Connect ${res.status}`, data.errors ?? []);
  }
  return data as T;
}

/** Cheap call that proves the key works and has app access. */
export async function verifyCredentials(c: AscCredentials) {
  await asc(c, "/v1/apps?limit=1&fields[apps]=bundleId");
}

/** The App Store Connect app record cannot be created via the public API; we detect it once the user creates it. */
export async function findAppByBundleId(c: AscCredentials, bundleId: string): Promise<{ id: string } | null> {
  const r = await asc<{ data: { id: string }[] }>(
    c,
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId,name`,
  );
  return r.data[0] ?? null;
}

type Resource = { id: string; attributes: Record<string, unknown> };

export async function ensureAppStoreVersion(c: AscCredentials, appId: string, versionString: string): Promise<Resource> {
  const existing = await asc<{ data: Resource[] }>(
    c,
    `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS`,
  );
  if (existing.data[0]) return existing.data[0];
  const created = await asc<{ data: Resource }>(c, "/v1/appStoreVersions", {
    method: "POST",
    json: {
      data: {
        type: "appStoreVersions",
        attributes: { platform: "IOS", versionString, releaseType: "AFTER_APPROVAL" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  });
  return created.data;
}

/** Returns the build once Apple finished processing it (null while still processing). */
export async function findProcessedBuild(c: AscCredentials, appId: string, buildNumber: number) {
  const r = await asc<{ data: Resource[] }>(
    c,
    `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&filter[processingState]=VALID&limit=1`,
  );
  return r.data[0] ?? null;
}

export async function attachBuild(c: AscCredentials, versionId: string, buildId: string) {
  await asc(c, `/v1/appStoreVersions/${versionId}/relationships/build`, {
    method: "PATCH",
    json: { data: { type: "builds", id: buildId } },
  });
}

export async function updateVersionLocalization(
  c: AscCredentials,
  versionId: string,
  attrs: { description?: string; keywords?: string; supportUrl?: string; marketingUrl?: string },
) {
  const locs = await asc<{ data: Resource[] }>(c, `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  for (const loc of locs.data) {
    await asc(c, `/v1/appStoreVersionLocalizations/${loc.id}`, {
      method: "PATCH",
      json: { data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: attrs } },
    });
  }
}

export async function submitForReview(c: AscCredentials, appId: string, versionId: string) {
  const submission = await asc<{ data: Resource }>(c, "/v1/reviewSubmissions", {
    method: "POST",
    json: {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  });
  await asc(c, "/v1/reviewSubmissionItems", {
    method: "POST",
    json: {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submission.data.id } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    },
  });
  await asc(c, `/v1/reviewSubmissions/${submission.data.id}`, {
    method: "PATCH",
    json: { data: { type: "reviewSubmissions", id: submission.data.id, attributes: { submitted: true } } },
  });
  return submission.data.id;
}

/** Maps App Store version state → our submission_status. */
export function mapAppStoreState(state: string): "in_review" | "approved" | "published" | "rejected" | "removed" | null {
  switch (state) {
    case "WAITING_FOR_REVIEW":
    case "IN_REVIEW":
    case "PENDING_APPLE_RELEASE":
      return "in_review";
    case "PENDING_DEVELOPER_RELEASE":
    case "PROCESSING_FOR_APP_STORE":
    case "ACCEPTED":
      return "approved";
    case "READY_FOR_SALE":
    case "READY_FOR_DISTRIBUTION":
      return "published";
    case "REJECTED":
    case "METADATA_REJECTED":
    case "INVALID_BINARY":
      return "rejected";
    case "REMOVED_FROM_SALE":
    case "DEVELOPER_REMOVED_FROM_SALE":
      return "removed";
    default:
      return null;
  }
}
