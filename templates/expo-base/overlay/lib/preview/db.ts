/**
 * Preview database (ADR-010): Postgres running inside the browser via PGlite.
 * It plays the role of the app's own Supabase project while the owner previews:
 * no server, no cost (NFR-007). Only fake demo data lives here.
 */
/** The subset of PGlite used here (kept local so the app does not depend on PGlite's types). */
export interface PreviewQueryResult<T> {
  rows: T[];
  fields: { name: string }[];
}
export interface PreviewTx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PreviewQueryResult<T>>;
  exec(sql: string): Promise<unknown>;
}
export interface PreviewDb extends PreviewTx {
  transaction<T>(fn: (tx: PreviewTx) => Promise<T>): Promise<T>;
}

/** The parts of Supabase that app migrations rely on: roles, auth.uid(), auth.users. */
export const SUPABASE_SHIM_SQL = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create extension if not exists pgcrypto;
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  phone text,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$f$;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$f$;
grant usage on schema auth, extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant select on auth.users to service_role;
alter default privileges in schema public grant all on tables to service_role;
`;

export interface PreviewMigration {
  name: string;
  sql: string;
}

/** Applies the shim, then the app's migrations in order, each in its own transaction. */
export async function setupPreviewDb(db: PreviewDb, migrations: PreviewMigration[]) {
  await db.exec(SUPABASE_SHIM_SQL);
  const failures: { name: string; error: string }[] = [];
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      await db.exec(`begin;\n${m.sql}\n;commit;`);
    } catch (err) {
      await db.exec("rollback;").catch(() => undefined);
      failures.push({ name: m.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { failures };
}
