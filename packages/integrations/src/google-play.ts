import { createPrivateKey, sign } from "node:crypto";
import { base64url } from "@banna/shared/crypto";

/** Google Play Android Publisher API with a service-account JSON key. */
interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

export async function playAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }));
  const sig = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), createPrivateKey(sa.private_key));
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${base64url(sig)}`,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google token error: ${data.error_description ?? res.status}`);
  return data.access_token;
}

/**
 * The Play Developer API cannot create a new public app. The app must exist in
 * Play Console first (ops step). We probe by opening and discarding an edit.
 */
export async function playAppExists(token: string, packageName: string): Promise<boolean> {
  const res = await fetch(`${API}/${encodeURIComponent(packageName)}/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Play API ${res.status}: ${await res.text()}`);
  const edit = (await res.json()) as { id: string };
  await fetch(`${API}/${encodeURIComponent(packageName)}/edits/${edit.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return true;
}
