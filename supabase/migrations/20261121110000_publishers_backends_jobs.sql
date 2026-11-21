-- =============================================================================
-- Migration : 20261121110000_publishers_backends_jobs.sql
-- Decisions (2026-11-21, مصعب):
--   1. iOS apps are published under the CUSTOMER's own Apple Developer account
--      (App Store Review Guideline 4.2.6). Android may use the platform account
--      or the customer's own.
--   2. Every generated app gets its OWN dedicated Supabase project (full isolation).
-- Adds  : publisher_accounts, app_backends, backend_migrations, jobs (+ queue RPCs),
--         Vault helper RPCs, mobile_apps.publisher_account_id.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Types
-- -----------------------------------------------------------------------------
create type public.publisher_kind     as enum ('platform', 'customer');
create type public.publisher_status   as enum ('pending_verification', 'verified', 'invalid', 'revoked');
create type public.backend_status     as enum ('provisioning', 'active', 'paused', 'failed', 'deleting', 'deleted');
create type public.migration_status   as enum ('pending', 'applied', 'failed', 'blocked');
create type public.job_status         as enum ('queued', 'running', 'succeeded', 'failed', 'dead');

-- Store setup the API cannot do (create app record / first Play upload).
alter type public.submission_status add value if not exists 'awaiting_store_setup' after 'queued';

-- -----------------------------------------------------------------------------
-- 2. publisher_accounts  (who appears as the seller in the store)
-- -----------------------------------------------------------------------------
create table public.publisher_accounts (
  id                      uuid primary key default gen_random_uuid(),
  kind                    public.publisher_kind not null,
  owner_id                uuid references public.profiles (id) on delete cascade,  -- null for platform accounts
  platform                public.mobile_platform not null,
  display_name            text not null check (char_length(display_name) between 1 and 120),
  -- Apple
  apple_team_id           text check (apple_team_id ~ '^[A-Z0-9]{10}$'),
  asc_key_id              text check (asc_key_id ~ '^[A-Z0-9]{10}$'),
  asc_issuer_id           uuid,
  -- Google
  play_developer_id       text,
  -- Vault secret holding the .p8 private key (Apple) or service-account JSON (Google).
  credentials_secret_id   uuid,
  status                  public.publisher_status not null default 'pending_verification',
  last_error              text,
  verified_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint publisher_accounts_owner_chk check (
    (kind = 'platform' and owner_id is null) or (kind = 'customer' and owner_id is not null)),
  constraint publisher_accounts_apple_fields_chk check (
    platform <> 'ios' or (apple_team_id is not null and asc_key_id is not null and asc_issuer_id is not null)),
  -- Policy decision: no platform-owned iOS publisher.
  constraint publisher_accounts_ios_customer_only_chk check (platform <> 'ios' or kind = 'customer')
);
create index publisher_accounts_owner_idx on public.publisher_accounts (owner_id);
create unique index publisher_accounts_apple_key_uq
  on public.publisher_accounts (owner_id, apple_team_id, asc_key_id) where platform = 'ios' and status <> 'revoked';
create unique index publisher_accounts_one_platform_android_uq
  on public.publisher_accounts (platform) where kind = 'platform' and status <> 'revoked';

create trigger publisher_accounts_set_updated_at
  before update on public.publisher_accounts
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. mobile_apps → publisher
-- -----------------------------------------------------------------------------
alter table public.mobile_apps
  add column publisher_account_id uuid references public.publisher_accounts (id) on delete restrict;
create index mobile_apps_publisher_idx on public.mobile_apps (publisher_account_id);

-- The publisher must match the platform, and a customer publisher must belong
-- to the project owner. iOS must use a customer publisher (4.2.6).
create or replace function private.check_mobile_app_publisher()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pub   public.publisher_accounts%rowtype;
  v_owner uuid;
begin
  if new.publisher_account_id is null then
    return new;
  end if;
  select * into v_pub from public.publisher_accounts where id = new.publisher_account_id;
  select owner_id into v_owner from public.projects where id = new.project_id;

  if v_pub.platform <> new.platform then
    raise exception 'publisher platform % does not match app platform %', v_pub.platform, new.platform
      using errcode = '23514';
  end if;
  if v_pub.kind = 'customer' and v_pub.owner_id is distinct from v_owner then
    raise exception 'publisher account does not belong to the project owner' using errcode = '42501';
  end if;
  if new.platform = 'ios' and v_pub.kind <> 'customer' then
    raise exception 'iOS apps must be published under the customer''s own Apple account' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger mobile_apps_check_publisher
  before insert or update of publisher_account_id, platform, project_id on public.mobile_apps
  for each row execute function private.check_mobile_app_publisher();

-- EAS project (one per generated app, under the platform's Expo account) and the
-- App Store version id used by the review tracker. Both service_role only.
alter table public.projects add column eas_project_id text unique;
alter table public.store_submissions add column store_version_id text;

-- -----------------------------------------------------------------------------
-- 4. app_backends  (one dedicated Supabase project per generated app)
-- -----------------------------------------------------------------------------
create table public.app_backends (
  id                      uuid primary key default gen_random_uuid(),
  -- RESTRICT: deprovision the Supabase project (job `backend.deprovision`) before deleting.
  project_id              uuid not null unique references public.projects (id) on delete restrict,
  supabase_project_ref    text unique check (supabase_project_ref ~ '^[a-z0-9]{20}$'),
  organization_slug       text not null,
  region_code             text not null default 'emea',   -- smart region group: americas | emea | apac
  instance_size           text,                           -- null = smallest (Nano if enabled for the org)
  status                  public.backend_status not null default 'provisioning',
  api_url                 text check (api_url ~ '^https://'),
  publishable_key         text,          -- safe to ship in the client bundle
  secret_key_secret_id    uuid,          -- Vault: sb_secret_* (server-side only)
  db_password_secret_id   uuid,          -- Vault: generated DB password
  auth_config             jsonb not null default '{}'::jsonb,
  last_migration_at       timestamptz,
  last_error              text,
  provisioned_at          timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger app_backends_set_updated_at
  before update on public.app_backends
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. backend_migrations  (SQL generated by the AI for the app's own database)
-- -----------------------------------------------------------------------------
create table public.backend_migrations (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null,
  app_backend_id  uuid not null references public.app_backends (id) on delete cascade,
  version_id      uuid not null,
  name            text not null check (char_length(name) between 1 and 120),
  sql             text not null check (char_length(sql) <= 200000),
  checksum        text not null check (checksum ~ '^[a-f0-9]{64}$'),
  is_destructive  boolean not null default false,   -- DROP / TRUNCATE / DELETE without WHERE / ALTER ... DROP
  status          public.migration_status not null default 'pending',
  error_message   text,
  applied_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint backend_migrations_version_fk foreign key (version_id, project_id)
    references public.project_versions (id, project_id) on delete cascade,
  constraint backend_migrations_checksum_uq unique (app_backend_id, checksum)
);
create index backend_migrations_project_idx on public.backend_migrations (project_id, created_at);
create index backend_migrations_version_idx on public.backend_migrations (version_id);
create index backend_migrations_pending_idx on public.backend_migrations (app_backend_id, created_at)
  where status = 'pending';

-- -----------------------------------------------------------------------------
-- 6. jobs  (durable queue for the worker: FOR UPDATE SKIP LOCKED)
-- -----------------------------------------------------------------------------
create table public.jobs (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind ~ '^[a-z][a-z0-9_.]{2,63}$'),
  payload       jsonb not null default '{}'::jsonb,
  project_id    uuid references public.projects (id) on delete cascade,
  status        public.job_status not null default 'queued',
  attempts      integer not null default 0,
  max_attempts  integer not null default 5 check (max_attempts between 1 and 50),
  run_after     timestamptz not null default now(),
  locked_by     text,
  locked_until  timestamptz,
  dedupe_key    text,
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index jobs_ready_idx on public.jobs (run_after) where status = 'queued';
create index jobs_running_lease_idx on public.jobs (locked_until) where status = 'running';
create index jobs_project_idx on public.jobs (project_id, created_at desc);
create unique index jobs_dedupe_active_uq on public.jobs (dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function private.set_updated_at();

create or replace function public.enqueue_job(
  p_kind        text,
  p_payload     jsonb default '{}'::jsonb,
  p_project_id  uuid default null,
  p_dedupe_key  text default null,
  p_run_after   timestamptz default now(),
  p_max_attempts integer default 5
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.jobs (kind, payload, project_id, dedupe_key, run_after, max_attempts)
  values (p_kind, coalesce(p_payload, '{}'::jsonb), p_project_id, p_dedupe_key, p_run_after, p_max_attempts)
  on conflict (dedupe_key) where dedupe_key is not null and status in ('queued', 'running')
  do nothing
  returning id into v_id;

  if v_id is null then   -- an identical job is already pending: return it (idempotent)
    select id into v_id from public.jobs
     where dedupe_key = p_dedupe_key and status in ('queued', 'running');
  end if;
  return v_id;
end;
$$;

-- Claim up to p_limit ready jobs (also reclaims jobs whose lease expired).
create or replace function public.claim_jobs(
  p_worker  text,
  p_kinds   text[] default null,
  p_limit   integer default 1,
  p_lease   interval default interval '15 minutes'
)
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with ready as (
    select j.id
      from public.jobs j
     where ((j.status = 'queued' and j.run_after <= now())
            or (j.status = 'running' and j.locked_until < now()))
       and (p_kinds is null or j.kind = any (p_kinds))
     order by j.run_after
     limit greatest(p_limit, 1)
     for update skip locked
  )
  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_by = p_worker,
         locked_until = now() + p_lease
    from ready
   where j.id = ready.id
  returning j.*;
end;
$$;

-- Finish a job. On failure it is retried with exponential backoff until max_attempts.
create or replace function public.finish_job(
  p_job_id  bigint,
  p_ok      boolean,
  p_result  jsonb default null,
  p_error   text default null,
  p_retry   boolean default true
)
returns public.job_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job    public.jobs%rowtype;
  v_status public.job_status;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'job % not found', p_job_id using errcode = 'P0002';
  end if;

  if p_ok then
    v_status := 'succeeded';
  elsif p_retry and v_job.attempts < v_job.max_attempts then
    v_status := 'queued';
  elsif p_retry then
    v_status := 'dead';
  else
    v_status := 'failed';
  end if;

  update public.jobs
     set status = v_status,
         result = coalesce(p_result, result),
         last_error = p_error,
         locked_by = null,
         locked_until = null,
         run_after = case when v_status = 'queued'
                          then now() + make_interval(secs => least(3600, 15 * power(2, v_job.attempts)::int))
                          else run_after end
   where id = p_job_id;
  return v_status;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Vault helpers (service_role only). Secrets never live in plain columns.
-- -----------------------------------------------------------------------------
create or replace function public.vault_store_secret(p_secret text, p_name text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return vault.create_secret(p_secret, p_name, p_description);
end;
$$;

create or replace function public.vault_read_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where id = p_secret_id;
$$;

create or replace function public.vault_delete_secret(p_secret_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from vault.secrets where id = p_secret_id;
$$;

-- -----------------------------------------------------------------------------
-- 8. RLS
-- -----------------------------------------------------------------------------
alter table public.publisher_accounts  enable row level security;
alter table public.app_backends        enable row level security;
alter table public.backend_migrations  enable row level security;
alter table public.jobs                enable row level security;

create policy "publisher_accounts: read own"
  on public.publisher_accounts for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "app_backends: read own project"
  on public.app_backends for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "backend_migrations: read own project"
  on public.backend_migrations for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "jobs: read own project"
  on public.jobs for select to authenticated
  using (project_id is not null and (select private.owns_project(project_id)));

-- -----------------------------------------------------------------------------
-- 9. Privileges
-- -----------------------------------------------------------------------------
revoke all on public.publisher_accounts, public.app_backends, public.backend_migrations, public.jobs
  from anon, authenticated;
grant all on public.publisher_accounts, public.app_backends, public.backend_migrations, public.jobs
  to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Column-level SELECT: users never see Vault secret ids.
grant select (id, kind, owner_id, platform, display_name, apple_team_id, asc_key_id, asc_issuer_id,
              play_developer_id, status, last_error, verified_at, created_at, updated_at)
  on public.publisher_accounts to authenticated;
grant select (id, project_id, supabase_project_ref, region_code, instance_size, status, api_url,
              publishable_key, last_migration_at, last_error, provisioned_at, created_at, updated_at)
  on public.app_backends to authenticated;
grant select on public.backend_migrations to authenticated;
grant select (id, kind, project_id, status, attempts, run_after, last_error, created_at, updated_at)
  on public.jobs to authenticated;

revoke all on function private.check_mobile_app_publisher() from public, anon, authenticated;
revoke all on function public.enqueue_job(text, jsonb, uuid, text, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.claim_jobs(text, text[], integer, interval) from public, anon, authenticated;
revoke all on function public.finish_job(bigint, boolean, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.vault_store_secret(text, text, text) from public, anon, authenticated;
revoke all on function public.vault_read_secret(uuid) from public, anon, authenticated;
revoke all on function public.vault_delete_secret(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_job(text, jsonb, uuid, text, timestamptz, integer) to service_role;
grant execute on function public.claim_jobs(text, text[], integer, interval) to service_role;
grant execute on function public.finish_job(bigint, boolean, jsonb, text, boolean) to service_role;
grant execute on function public.vault_store_secret(text, text, text) to service_role;
grant execute on function public.vault_read_secret(uuid) to service_role;
grant execute on function public.vault_delete_secret(uuid) to service_role;

-- Not added to Realtime: column-level SELECT grants hide secret ids, and Realtime
-- needs full-row SELECT. The dashboard polls these (low-frequency state).
