import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";
import { buildExport } from "@banna/integrations/export";

test("export drops env and key files, redacts secrets, adds schema and README", () => {
  const files = {
    "package.json": "{}",
    ".env": "SECRET=1",
    "android/upload.jks": "binary",
    "src/app/index.tsx": `const k = "sk_live_abcdefghijklmnop"; const a = "sk-ant-abcdefghijkl";`,
    "supabase/migrations/20261121153000_01_b.sql": "create table b();\n",
    "supabase/migrations/20261121153000_00_a.sql": "create table a();\n",
  };
  const r = buildExport(files, { appName: "متجري", slug: "my-shop", version: 3 });
  assert.deepEqual(r.removed.sort(), [".env", "android/upload.jks"]);
  assert.equal(r.redacted.length, 2);

  const unzipped: Record<string, string> = Object.fromEntries(Object.entries(unzipSync(r.zip)).map(([p, b]) => [p, strFromU8(b)]));
  assert.ok(!("my-shop/.env" in unzipped));
  assert.ok(!(unzipped["my-shop/src/app/index.tsx"] ?? "").includes("sk_live_"));
  assert.ok(!(unzipped["my-shop/src/app/index.tsx"] ?? "").includes("sk-ant-"));
  const schema = unzipped["my-shop/supabase/schema.sql"] ?? "";
  assert.ok(schema.indexOf("create table a") < schema.indexOf("create table b"));
  assert.match(unzipped["my-shop/README.md"] ?? "", /متجري \(v3\)/);
  assert.ok("my-shop/.env.example" in unzipped);
  assert.equal(r.fileCount, Object.keys(unzipped).length);
});
