import { test } from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS_DIR, checkMigrations, withMigrationFiles } from "@banna/generator/pipeline";
import { applyOperations, renderSpecContext } from "@banna/generator/generate";
import { isLockedPath } from "@banna/shared/snapshots";
import { flowerShop } from "./fixtures/flower-shop.spec";

test("generated SQL is stored as ordered, sanitised files under supabase/migrations/", () => {
  const files = withMigrationFiles(
    { "app/index.tsx": "x" },
    [
      { name: "Create Orders!", sql: "create table orders();" },
      { name: "../../etc", sql: "select 1;\n" },
    ],
    new Date("2026-11-21T15:30:00Z"),
  );
  const paths = Object.keys(files).filter((p) => p.startsWith(MIGRATIONS_DIR)).sort();
  assert.deepEqual(paths, [
    "supabase/migrations/20261121153000_00_create_orders.sql",
    "supabase/migrations/20261121153000_01_etc.sql",
  ]);
  assert.equal(files[paths[0]!], "create table orders();\n");
  assert.equal(files["app/index.tsx"], "x");
  assert.ok(paths.every(isLockedPath), "the AI can never overwrite these files");
});

test("the AI cannot write migration files itself", () => {
  const { files, rejected } = applyOperations({}, [{ type: "write", path: "supabase/migrations/x.sql", content: "drop table a;" }]);
  assert.deepEqual(files, {});
  assert.deepEqual(rejected, ["supabase/migrations/x.sql"]);
});

test("checkMigrations flags destructive and forbidden SQL", () => {
  const [ok, destructive, forbidden] = checkMigrations([
    { name: "a", sql: "create table if not exists t (id uuid primary key);" },
    { name: "b", sql: "drop table t;" },
    { name: "c", sql: "alter table auth.users add column x int;" },
  ]);
  assert.equal(ok!.destructive, false);
  assert.equal(ok!.forbiddenReason, null);
  assert.match(ok!.checksum, /^[a-f0-9]{64}$/);
  assert.equal(destructive!.destructive, true);
  assert.ok(forbidden!.forbiddenReason);
});

test("spec context includes the approved spec and the list of changes", () => {
  assert.equal(renderSpecContext({ spec: null, specChanges: null }), "");
  const ctx = renderSpecContext({ spec: flowerShop, specChanges: [{ kind: "added", area: "screen", name: "offers" }] });
  assert.match(ctx, /<approved_spec>/);
  assert.match(ctx, /"name": /);
  assert.match(ctx, /- added screen offers/);
});
