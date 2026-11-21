import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@banna/shared/errors";
import { enqueueJob } from "@banna/shared/jobs";
import { sha256 } from "@banna/shared/crypto";
import { creditsForUsage, type AiUsage } from "@banna/shared/credits";
import {
  assertWithinLimits,
  contentHash,
  fileManifest,
  loadTemplate,
  loadVersionFiles,
  nativeFingerprint,
  saveSnapshot,
  snapshotPath,
  type ProjectFiles,
} from "@banna/shared/snapshots";
import type { AppSpec } from "@banna/spec/schema";
import type { SpecChange } from "@banna/spec/diff";
import { MODEL, applyOperations, classifyMigrationSql, generateApp, type GenerateInput } from "./generate";

/**
 * One generation run, shared by the app.generate job (approved spec) and
 * /api/generate (cosmetic edit). Credits are the caller's business.
 *
 * Backend SQL is stored inside the version snapshot under supabase/migrations/
 * (a path the AI cannot write). An app's backend exists only after payment
 * (NFR-007, T-07), so provisioning applies these files then; when a backend is
 * already active, they are also queued for it right away.
 */

export const MIGRATIONS_DIR = "supabase/migrations/";

export interface CheckedMigration {
  name: string;
  sql: string;
  destructive: boolean;
  forbiddenReason: string | null;
  checksum: string;
}

/** Adds generated migrations as timestamped files: 20261121153000_00_create_orders.sql */
export function withMigrationFiles(files: ProjectFiles, migrations: { name: string; sql: string }[], at: Date): ProjectFiles {
  if (!migrations.length) return files;
  const stamp = at.toISOString().replace(/\D/g, "").slice(0, 14);
  const out = { ...files };
  migrations.forEach((m, i) => {
    const safe = m.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "change";
    out[`${MIGRATIONS_DIR}${stamp}_${String(i).padStart(2, "0")}_${safe}.sql`] = m.sql.endsWith("\n") ? m.sql : `${m.sql}\n`;
  });
  return out;
}

export function checkMigrations(migrations: { name: string; sql: string }[]): CheckedMigration[] {
  return migrations.map((m) => ({ ...m, ...classifyMigrationSql(m.sql), checksum: sha256(m.sql) }));
}

export interface RunGenerationInput {
  projectId: string;
  userId: string;
  prompt: string;
  kind: GenerateInput["kind"];
  spec: AppSpec;
  specId: string;
  specChanges: SpecChange[] | null;
  /** Credits held for this run (CR-004); the version records what was actually charged. */
  held: number;
  /** Usage of model calls made before this run for the same operation (e.g. the edit classifier). */
  priorUsage?: AiUsage[];
  /** Version to build on; null = the project's current version (or the template). */
  baseVersionId: string | null;
}

export async function runGeneration(admin: SupabaseClient, input: RunGenerationInput) {
  const { data: project, error: projectError } = await admin
    .from("projects")
    .select("id, status, current_version_id")
    .eq("id", input.projectId)
    .single();
  if (projectError) throw projectError;

  // Optimistic lock: one generation per project at a time.
  const { data: locked, error: lockError } = await admin
    .from("projects")
    .update({ status: "generating" })
    .eq("id", input.projectId)
    .neq("status", "generating")
    .select("id");
  if (lockError) throw lockError;
  if (!locked?.length) throw new HttpError(409, "generation_in_progress", "Another change is being generated");

  try {
    const baseVersionId = input.baseVersionId ?? (project.current_version_id as string | null);
    const isNewProject = !baseVersionId;

    let baseFiles: ProjectFiles;
    if (baseVersionId) {
      const { version, files } = await loadVersionFiles(admin, baseVersionId);
      if (version.project_id !== input.projectId) throw new HttpError(400, "invalid_base_version", "Version not in project");
      baseFiles = files;
    } else {
      baseFiles = await loadTemplate(admin);
      if (Object.keys(baseFiles).length === 0) throw new Error("Base template is not uploaded (run build:template)");
    }

    const { data: historyRows } = await admin
      .from("project_versions")
      .select("prompt, summary")
      .eq("project_id", input.projectId)
      .order("version_number", { ascending: false })
      .limit(10);
    const history = (historyRows ?? [])
      .reverse()
      .filter((h) => h.prompt && h.summary)
      .map((h) => ({ prompt: h.prompt as string, summary: h.summary as string }));

    const started = Date.now();
    const usages: AiUsage[] = [...(input.priorUsage ?? [])];
    const gen = await generateApp({
      onUsage: (u) => usages.push(u),
      isNewProject,
      kind: isNewProject ? "new_app" : input.kind,
      prompt: input.prompt,
      spec: input.spec,
      specChanges: input.specChanges,
      files: baseFiles,
      history,
    });

    const migrations = checkMigrations(gen.backend_migrations);
    const forbidden = migrations.find((m) => m.forbiddenReason);
    if (forbidden) throw new HttpError(422, "unsafe_sql", "Generated database change was blocked", forbidden.name);

    const applied = applyOperations(baseFiles, gen.operations);
    const files = withMigrationFiles(applied.files, migrations, new Date());
    assertWithinLimits(files);

    // persist: snapshot first, then the row that points at it
    const versionId = randomUUID();
    const storagePath = snapshotPath(input.projectId, versionId);
    await saveSnapshot(admin, storagePath, files);

    const { data: version, error: versionError } = await admin
      .from("project_versions")
      .insert({
        id: versionId,
        project_id: input.projectId,
        version_number: 1, // overwritten by trigger
        parent_version_id: baseVersionId,
        source: isNewProject ? "ai_generation" : "ai_edit",
        prompt: input.prompt,
        summary: gen.summary,
        storage_path: storagePath,
        file_manifest: fileManifest(files),
        content_hash: contentHash(files),
        native_fingerprint: nativeFingerprint(files),
        ai_model: MODEL,
        credits_charged: creditsForUsage(usages, input.held),
        created_by: input.userId,
        spec_id: input.specId,
      })
      .select("id, version_number, summary, native_fingerprint, created_at, credits_charged")
      .single();
    if (versionError) throw versionError;

    await queueForActiveBackend(admin, input.projectId, versionId, migrations);

    const { error: pointerError } = await admin
      .from("projects")
      .update({ current_version_id: versionId, status: "ready" })
      .eq("id", input.projectId);
    if (pointerError) throw pointerError;

    return {
      version,
      creditsCharged: version.credits_charged as number,
      summary: gen.summary,
      changedFiles: gen.operations.length - applied.rejected.length,
      protectedFiles: applied.rejected,
      backendMigrations: migrations.map((m) => ({ name: m.name, needsApproval: m.destructive })),
      needsNativeChange: gen.needs_native_change,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    await admin
      .from("projects")
      .update({ status: project.current_version_id ? "ready" : "error" })
      .eq("id", input.projectId);
    throw err;
  }
}

/**
 * Only an existing backend gets SQL rows now (applied right away when active; at the
 * end of provisioning otherwise). Without a backend, provisioning reads the snapshot's files.
 */
async function queueForActiveBackend(admin: SupabaseClient, projectId: string, versionId: string, migrations: CheckedMigration[]) {
  if (!migrations.length) return;
  const { data: backend } = await admin.from("app_backends").select("id, status").eq("project_id", projectId).maybeSingle();
  if (!backend || !["provisioning", "active"].includes(backend.status as string)) return;

  const { error } = await admin.from("backend_migrations").upsert(
    migrations.map((m) => ({
      project_id: projectId,
      app_backend_id: backend.id,
      version_id: versionId,
      name: m.name.slice(0, 120),
      sql: m.sql,
      checksum: m.checksum,
      is_destructive: m.destructive,
      status: m.destructive ? "blocked" : "pending", // destructive SQL waits for explicit user approval
    })),
    { onConflict: "app_backend_id,checksum", ignoreDuplicates: true },
  );
  if (error) throw error;
  if (backend.status !== "active") return;
  await enqueueJob(admin, "backend.apply_migrations", { appBackendId: backend.id }, {
    projectId,
    dedupeKey: `backend.migrate:${projectId}`,
  });
}
