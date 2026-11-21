import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const sha1 = (data: string | Buffer) => createHash("sha1").update(data).digest("hex");

/** Constant-time HMAC check. `received` may carry a prefix such as "sha1=". */
export function verifyHmac(
  algorithm: "sha1" | "sha256",
  secret: string,
  rawBody: string,
  received: string | null,
  prefix = "",
): boolean {
  if (!received || !received.startsWith(prefix)) return false;
  const expected = createHmac(algorithm, secret).update(rawBody, "utf8").digest("hex");
  const got = received.slice(prefix.length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(got, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const randomSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");
