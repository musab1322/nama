import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { applyOperations, classifyMigrationSql } from "@banna/generator/generate";
import { contentHash, isLockedPath, nativeFingerprint, normalizePath } from "@banna/shared/snapshots";
import { verifyHmac } from "@banna/shared/crypto";
import { ascToken, mapAppStoreState } from "@banna/integrations/apple";

test("path validation blocks traversal and absolute paths", () => {
  assert.equal(normalizePath("./app/index.tsx"), "app/index.tsx");
  for (const bad of ["../x", "/etc/passwd", "app/../../x", "a//b", "app/./x"]) assert.throws(() => normalizePath(bad));
});

test("AI cannot write platform-owned files", () => {
  const base = { "package.json": "{}", "app/index.tsx": "old" };
  const { files, rejected } = applyOperations(base, [
    { type: "write", path: "package.json", content: '{"dependencies":{"evil":"1"}}' },
    { type: "write", path: ".env", content: "X=1" },
    { type: "write", path: "lib/supabase.ts", content: "x" },
    { type: "write", path: "../outside.ts", content: "x" },
    { type: "write", path: "app/index.tsx", content: "new" },
    { type: "write", path: "app/(tabs)/[id].tsx", content: "page" },
  ]);
  assert.equal(files["package.json"], "{}");
  assert.equal(files["app/index.tsx"], "new");
  assert.equal(files["app/(tabs)/[id].tsx"], "page");
  assert.deepEqual(rejected.sort(), [".env", "../outside.ts", "lib/supabase.ts", "package.json"].sort());
  assert.ok(isLockedPath("ios/Podfile"));
});

test("native fingerprint ignores JS-only edits", () => {
  const a = { "package.json": "{}", "app/index.tsx": "A" };
  const b = { ...a, "app/index.tsx": "B", "components/x.tsx": "C" };
  assert.equal(nativeFingerprint(a), nativeFingerprint(b));
  assert.notEqual(contentHash(a), contentHash(b));
  assert.notEqual(nativeFingerprint(a), nativeFingerprint({ ...a, "package.json": '{"x":1}' }));
});

test("SQL guard", () => {
  const ok = classifyMigrationSql("create table if not exists public.todos (id bigint primary key); alter table public.todos enable row level security;");
  assert.deepEqual(ok, { destructive: false, forbiddenReason: null });
  assert.equal(classifyMigrationSql("drop table public.orders;").destructive, true);
  assert.equal(classifyMigrationSql("delete from public.orders;").destructive, true);
  assert.equal(classifyMigrationSql("delete from public.orders where id = 1;").destructive, false);
  assert.equal(classifyMigrationSql("update public.t set a = 1;").destructive, true);
  assert.equal(classifyMigrationSql("update public.t set a = 1 where id = 2;").destructive, false);
  assert.ok(classifyMigrationSql("alter table auth.users add column x int;").forbiddenReason);
  assert.ok(classifyMigrationSql("create role hacker;").forbiddenReason);
  assert.ok(classifyMigrationSql("create function public.f() returns void language sql security definer as $$ select 1 $$;").forbiddenReason);
  assert.equal(
    classifyMigrationSql("create function public.f() returns void language sql security definer set search_path = '' as $$ select 1 $$;").forbiddenReason,
    null,
  );
  // references to auth.users are fine
  assert.equal(classifyMigrationSql("create table public.p (user_id uuid references auth.users(id));").forbiddenReason, null);
});

test("webhook HMAC", () => {
  const body = '{"a":1}';
  const sig = createHmac("sha1", "s3cret-s3cret-s3cret").update(body).digest("hex");
  assert.ok(verifyHmac("sha1", "s3cret-s3cret-s3cret", body, `sha1=${sig}`, "sha1="));
  assert.ok(!verifyHmac("sha1", "s3cret-s3cret-s3cret", body + " ", `sha1=${sig}`, "sha1="));
  assert.ok(!verifyHmac("sha1", "s3cret-s3cret-s3cret", body, null));
  assert.ok(!verifyHmac("sha1", "s3cret-s3cret-s3cret", body, "sha1=zz"));
});

test("App Store Connect ES256 JWT verifies with the public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = ascToken({ keyId: "ABC1234567", issuerId: "00000000-0000-0000-0000-000000000000", privateKeyP8: pem }, 1000);
  const [h, p, s] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "ES256", kid: "ABC1234567", typ: "JWT" });
  assert.equal(JSON.parse(Buffer.from(p!, "base64url").toString()).exp, 2200);
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));
});

test("App Store state mapping", () => {
  assert.equal(mapAppStoreState("WAITING_FOR_REVIEW"), "in_review");
  assert.equal(mapAppStoreState("READY_FOR_SALE"), "published");
  assert.equal(mapAppStoreState("REJECTED"), "rejected");
  assert.equal(mapAppStoreState("PREPARE_FOR_SUBMISSION"), null);
});
