import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { withPreviewConfig, PREVIEW_CONFIG_PATH } from "@banna/integrations/preview";
import { isLockedPath } from "@banna/shared/snapshots";
import { functionsFromFiles } from "../apps/worker/src/handlers/backend";

const OVERLAY = fileURLToPath(new URL("../templates/expo-base/overlay/", import.meta.url));

async function list(dir: string, out: string[] = []) {
  for (const e of await readdir(dir)) {
    const full = join(dir, e);
    if ((await stat(full)).isDirectory()) await list(full, out);
    else out.push(relative(OVERLAY, full));
  }
  return out;
}

test("every platform-owned template file is locked against the AI", async () => {
  const files = await list(OVERLAY);
  assert.ok(files.length >= 12);
  const unlocked = files.filter((f) => !isLockedPath(f));
  assert.deepEqual(unlocked, []);
  assert.equal(isLockedPath("preview/seed.sql"), false, "the AI writes the demo data");
  assert.equal(isLockedPath("src/app/(tabs)/index.tsx"), false);
});

test("preview builds embed the app's migrations in order and the demo data", () => {
  const files = withPreviewConfig({
    "src/lib/preview/config.ts": "export const PREVIEW = false;",
    "supabase/migrations/20261121160000_00_b.sql": "select 2;",
    "supabase/migrations/00000000000000_platform_base.sql": "select 1;",
    "preview/seed.sql": "insert into products (name) values ('ورد');",
  });
  const cfg = files[PREVIEW_CONFIG_PATH]!;
  assert.match(cfg, /export const PREVIEW = true;/);
  assert.ok(cfg.indexOf("00000000000000_platform_base") < cfg.indexOf("20261121160000_00_b"));
  assert.match(cfg, /ورد/);
});

test("the template's production config keeps the preview off", async () => {
  const cfg = await readFile(join(OVERLAY, "src/lib/preview/config.ts"), "utf8");
  assert.match(cfg, /export const PREVIEW = false;/);
});

test("platform functions are read from the snapshot", () => {
  const fns = functionsFromFiles({
    "supabase/functions/payments/index.ts": "a",
    "supabase/functions/delete-account/index.ts": "b",
    "supabase/functions/Bad_Name/index.ts": "c",
    "supabase/functions/payments/helper.ts": "d",
  });
  assert.deepEqual(fns.map((f) => f.name), ["delete-account", "payments"]);
});
