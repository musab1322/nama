/**
 * Builds the base Expo template every generated app starts from and uploads it to
 * storage (project-sources/templates/expo-base/current.json.gz).
 *
 *   npm run build:template
 *
 * Versions come from create-expo-app + `expo install`, so they always match one Expo SDK.
 * Run again to move all NEW apps to a newer SDK (existing apps keep their package.json;
 * upgrading them changes the native fingerprint, i.e. a new store release).
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { adminClient } from "@banna/shared/supabase-admin";
import { saveSnapshot, SOURCES_BUCKET, TEMPLATE_PATH, type ProjectFiles } from "@banna/shared/snapshots";
import { run } from "../apps/worker/src/support";

const DEPENDENCIES = [
  "@supabase/supabase-js",
  "@react-native-async-storage/async-storage",
  "react-native-url-polyfill",
  "expo-updates",
  "expo-secure-store",
  "expo-image",
  "expo-image-picker",
  "expo-notifications",
  "expo-linear-gradient",
  "react-native-svg",
  "react-hook-form",
  "zod",
  "date-fns",
  "zustand",
  "@tanstack/react-query",
  "expo-web-browser",
];

/** Platform-owned files copied over the Expo starter (templates/expo-base/overlay). */
const OVERLAY_DIR = fileURLToPath(new URL("../templates/expo-base/overlay/", import.meta.url));

const SKIP = new Set(["node_modules", ".git", ".expo", "dist", "ios", "android"]);

async function collect(root: string, dir = root, out: ProjectFiles = {}): Promise<ProjectFiles> {
  for (const entry of await readdir(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await collect(root, full, out);
    else if (s.size < 512 * 1024 && !/\.(png|jpg|jpeg|gif|ttf|otf|webp)$/i.test(entry)) {
      out[relative(root, full)] = await readFile(full, "utf8");
    }
  }
  return out;
}

const work = await mkdtemp(join(tmpdir(), "template-"));
try {
  await run("npx", ["--yes", "create-expo-app@5.0.0", "app", "--template", "default", "--no-install"], { cwd: work });
  const dir = join(work, "app");
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 20 * 60_000 });
  await run("npx", ["expo", "install", ...DEPENDENCIES], { cwd: dir, timeoutMs: 20 * 60_000 });
  for (const [rel, content] of Object.entries(await collect(OVERLAY_DIR))) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  // Published web apps are static files only (design §1.1): no server code runs for them.
  const appJson = JSON.parse(await readFile(join(dir, "app.json"), "utf8")) as { expo: Record<string, unknown> };
  appJson.expo.web = { ...((appJson.expo.web as object) ?? {}), output: "static", bundler: "metro" };
  await writeFile(join(dir, "app.json"), JSON.stringify(appJson, null, 2));
  const files = await collect(dir);
  const admin = adminClient();
  await admin.storage.from(SOURCES_BUCKET).remove([TEMPLATE_PATH]);
  await saveSnapshot(admin, TEMPLATE_PATH, files);
  console.log(`template uploaded: ${Object.keys(files).length} files`);
} finally {
  await rm(work, { recursive: true, force: true });
}
