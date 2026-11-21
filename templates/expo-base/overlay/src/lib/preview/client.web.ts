/**
 * Web preview: boots Postgres in the browser (PGlite) and serves the app's
 * supabase-js calls from it. PGlite is loaded from a CDN only in preview builds,
 * so it is never part of a published app.
 */
import { setupPreviewDb, type PreviewDb } from "./db";
import { createPreviewFetch } from "./rest";
import { PREVIEW_MIGRATIONS, PREVIEW_SEED } from "./config";

const PGLITE = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.17/dist";

type PGliteModule = { PGlite: new (opts?: unknown) => PreviewDb };
type PgcryptoModule = { pgcrypto: unknown };

// Built at runtime so the bundler leaves these URL imports alone.
const load = <T,>(url: string): Promise<T> => new Function("u", "return import(u)")(url) as Promise<T>;

export async function previewFetch(): Promise<typeof fetch> {
  const [{ PGlite }, { pgcrypto }] = await Promise.all([
    load<PGliteModule>(`${PGLITE}/index.js`),
    load<PgcryptoModule>(`${PGLITE}/contrib/pgcrypto.js`),
  ]);
  const db = new PGlite({ extensions: { pgcrypto } });
  const { failures } = await setupPreviewDb(db, PREVIEW_MIGRATIONS);
  if (failures.length) console.warn("[preview] migrations that did not apply:", failures);
  if (PREVIEW_SEED.trim()) {
    try {
      await db.exec(PREVIEW_SEED);
    } catch (err) {
      console.warn("[preview] demo data did not load:", err);
    }
  }
  return createPreviewFetch(db);
}
