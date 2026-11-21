-- =============================================================================
-- Migration : 20261121100000_platform_core.sql
-- Purpose   : Core schema for the AI app-builder platform (web + iOS + Android)
-- Tables    : profiles, credit_transactions, subscriptions, projects,
--             project_versions, web_deployments, domains, mobile_apps,
--             mobile_builds, store_submissions, ota_releases
--
-- Security model
--   * RLS is enabled on EVERY table.
--   * `anon` has no access to any table.
--   * `authenticated` can READ rows of projects they own, and can WRITE only a
--     small set of user-editable columns (enforced with column-level GRANTs,
--     not just policies).
--   * Everything that reflects the state of an external system (Vercel, EAS,
--     App Store Connect, Google Play, Capgo, Stripe/Moyasar) and every credit
--     movement is written ONLY by `service_role` from server code / webhooks.
--   * Helper functions live in the non-exposed `private` schema.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Schemas
-- -----------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. Enumerated types
-- -----------------------------------------------------------------------------
create type public.user_role            as enum ('user', 'admin');
create type public.plan_tier            as enum ('free', 'starter', 'pro', 'business');
create type public.payment_provider     as enum ('stripe', 'moyasar');
create type public.subscription_status  as enum ('trialing', 'active', 'past_due', 'canceled', 'incomplete', 'expired');
create type public.credit_reason        as enum ('signup_bonus', 'subscription_grant', 'purchase', 'generation', 'refund', 'adjustment');
create type public.project_status       as enum ('draft', 'generating', 'ready', 'error', 'archived');
create type public.version_source       as enum ('ai_generation', 'ai_edit', 'rollback', 'manual');
create type public.deployment_target    as enum ('preview', 'production');
create type public.deployment_status    as enum ('queued', 'building', 'ready', 'error', 'canceled');
create type public.domain_status        as enum ('pending', 'verifying', 'active', 'misconfigured', 'error', 'removed');
create type public.mobile_platform      as enum ('ios', 'android');
create type public.listing_status       as enum ('draft', 'ready', 'live', 'suspended', 'removed');
create type public.build_provider       as enum ('eas', 'codemagic');
create type public.build_status         as enum ('queued', 'in_progress', 'finished', 'errored', 'canceled');
create type public.submit_provider      as enum ('eas_submit', 'fastlane');
create type public.submission_status    as enum ('queued', 'submitting', 'submitted', 'in_review', 'approved', 'published', 'rejected', 'removed', 'error');
create type public.ota_provider         as enum ('eas_update', 'capgo');
create type public.ota_status           as enum ('pending', 'uploading', 'published', 'rolled_back', 'failed');

-- -----------------------------------------------------------------------------
-- 2. Generic helpers
-- -----------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. profiles  (1:1 with auth.users)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  email            text,
  full_name        text check (char_length(full_name) <= 120),
  avatar_url       text check (char_length(avatar_url) <= 2048),
  locale           text not null default 'ar' check (locale in ('ar', 'en')),
  role             public.user_role not null default 'user',
  credits_balance  integer not null default 0 check (credits_balance >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column public.profiles.credits_balance is
  'Denormalised balance. Maintained ONLY by the credit_transactions trigger; never update directly.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. credit_transactions  (append-only ledger; source of truth for credits)
-- -----------------------------------------------------------------------------
create table public.credit_transactions (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles (id) on delete cascade,
  amount         integer not null check (amount <> 0),
  balance_after  integer not null default 0,  -- overwritten by trigger
  reason         public.credit_reason not null,
  reference_id   text,                         -- e.g. project_version id, invoice id, payment id
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index credit_transactions_user_created_idx on public.credit_transactions (user_id, created_at desc);
-- Idempotency for webhooks / retries: the same (user, reason, reference) is applied once.
create unique index credit_transactions_idempotency_uq
  on public.credit_transactions (user_id, reason, reference_id)
  where reference_id is not null;

create or replace function private.apply_credit_transaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  update public.profiles
     set credits_balance = credits_balance + new.amount
   where id = new.user_id
  returning credits_balance into v_balance;   -- CHECK (>= 0) aborts on overdraft

  if not found then
    raise exception 'profile % not found', new.user_id using errcode = 'P0002';
  end if;

  new.balance_after := v_balance;
  return new;
end;
$$;

create trigger credit_transactions_apply
  before insert on public.credit_transactions
  for each row execute function private.apply_credit_transaction();

-- Ledger is append-only, even for service_role (corrections = new 'adjustment' row).
create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

create trigger credit_transactions_no_update
  before update or delete on public.credit_transactions
  for each row execute function private.forbid_mutation();

-- RPC for server code: spend credits atomically with a friendly error.
create or replace function public.spend_credits(
  p_user_id      uuid,
  p_amount       integer,
  p_reference_id text,
  p_metadata     jsonb default '{}'::jsonb
)
returns integer               -- new balance
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  if p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;

  -- Lock the profile row so concurrent generations cannot double-spend.
  select credits_balance into v_balance
    from public.profiles where id = p_user_id for update;

  if v_balance is null then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  if v_balance < p_amount then
    raise exception 'insufficient_credits' using errcode = 'P0001',
      detail = format('balance=%s required=%s', v_balance, p_amount);
  end if;

  insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
  values (p_user_id, -p_amount, 'generation', p_reference_id, coalesce(p_metadata, '{}'::jsonb))
  returning balance_after into v_balance;

  return v_balance;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. New-user bootstrap (profile + signup credits)
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_signup_credits constant integer := 50;   -- tune per business plan
begin
  insert into public.profiles (id, email, full_name, avatar_url, locale)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    case when new.raw_user_meta_data ->> 'locale' = 'en' then 'en' else 'ar' end
  )
  on conflict (id) do nothing;

  insert into public.credit_transactions (user_id, amount, reason, reference_id)
  values (new.id, c_signup_credits, 'signup_bonus', 'signup')
  on conflict do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- -----------------------------------------------------------------------------
-- 6. subscriptions  (written by Stripe / Moyasar webhooks only)
-- -----------------------------------------------------------------------------
create table public.subscriptions (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references public.profiles (id) on delete cascade,
  provider                  public.payment_provider not null,
  provider_customer_id      text,
  provider_subscription_id  text,
  plan                      public.plan_tier not null default 'free',
  status                    public.subscription_status not null,
  billing_interval          text check (billing_interval in ('month', 'year')),
  includes_store_publishing boolean not null default false,
  monthly_credits           integer not null default 0 check (monthly_credits >= 0),
  max_projects              integer check (max_projects is null or max_projects > 0),
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean not null default false,
  canceled_at               timestamptz,
  metadata                  jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint subscriptions_provider_sub_uq unique (provider, provider_subscription_id),
  constraint subscriptions_period_chk check (
    current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);
create index subscriptions_user_idx on public.subscriptions (user_id);
-- At most one live subscription per user.
create unique index subscriptions_one_live_per_user_uq
  on public.subscriptions (user_id)
  where status in ('trialing', 'active', 'past_due');

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. projects
-- -----------------------------------------------------------------------------
create table public.projects (
  id                            uuid primary key default gen_random_uuid(),
  owner_id                      uuid not null default auth.uid()
                                  references public.profiles (id) on delete cascade,
  name                          text not null check (char_length(btrim(name)) between 1 and 80),
  -- used as the default subdomain:  {slug}.yourplatform.app
  slug                          text not null unique
                                  check (slug ~ '^[a-z0-9]([a-z0-9-]{1,46})[a-z0-9]$'),
  description                   text check (char_length(description) <= 2000),
  initial_prompt                text check (char_length(initial_prompt) <= 20000),
  status                        public.project_status not null default 'draft',
  current_version_id            uuid,         -- FK added after project_versions exists
  app_config                    jsonb not null default '{}'::jsonb,  -- theme, locales, feature flags
  icon_path                     text,         -- storage path in bucket `project-assets`
  vercel_project_id             text unique,  -- service_role only
  store_publishing_unlocked_at  timestamptz,  -- set by payment webhook (one-time fee)
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
create index projects_owner_updated_idx on public.projects (owner_id, updated_at desc);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function private.set_updated_at();

-- Ownership helper used by every child-table policy.
-- SECURITY DEFINER so it can read `projects` without recursive RLS evaluation.
create or replace function private.owns_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
     where p.id = p_project_id
       and p.owner_id = (select auth.uid())
  );
$$;

-- -----------------------------------------------------------------------------
-- 8. project_versions  (immutable snapshots; rollback = move pointer)
-- -----------------------------------------------------------------------------
create table public.project_versions (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  version_number     integer not null check (version_number > 0),  -- assigned by trigger
  parent_version_id  uuid,
  source             public.version_source not null default 'ai_edit',
  prompt             text check (char_length(prompt) <= 20000),
  summary            text check (char_length(summary) <= 4000),
  storage_path       text not null,      -- bucket `project-sources`: {project_id}/{version_id}.json.gz
  file_manifest      jsonb not null default '[]'::jsonb check (jsonb_typeof(file_manifest) = 'array'),
  content_hash       text not null check (content_hash ~ '^[a-f0-9]{64}$'),   -- sha256
  -- hash of everything that requires a NEW NATIVE BUILD (native deps, plugins,
  -- permissions, icon, splash, bundle id, app name). Equal fingerprint => OTA is allowed.
  native_fingerprint text check (native_fingerprint ~ '^[a-f0-9]{64}$'),
  ai_model           text,
  input_tokens       integer check (input_tokens >= 0),
  output_tokens      integer check (output_tokens >= 0),
  credits_charged    integer not null default 0 check (credits_charged >= 0),
  created_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  constraint project_versions_number_uq unique (project_id, version_number),
  constraint project_versions_id_project_uq unique (id, project_id),
  constraint project_versions_parent_fk foreign key (parent_version_id, project_id)
    references public.project_versions (id, project_id)
);
create index project_versions_parent_idx on public.project_versions (parent_version_id) where parent_version_id is not null;

create or replace function private.assign_version_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- serialise concurrent inserts for the same project
  perform 1 from public.projects where id = new.project_id for update;
  select coalesce(max(v.version_number), 0) + 1
    into new.version_number
    from public.project_versions v
   where v.project_id = new.project_id;
  return new;
end;
$$;

create trigger project_versions_assign_number
  before insert on public.project_versions
  for each row execute function private.assign_version_number();

create trigger project_versions_immutable
  before update on public.project_versions
  for each row execute function private.forbid_mutation();

-- current_version_id must belong to the same project (prevents pointing at another tenant's version)
alter table public.projects
  add constraint projects_current_version_fk
  foreign key (current_version_id, id)
  references public.project_versions (id, project_id)
  on delete set null (current_version_id);

-- -----------------------------------------------------------------------------
-- 9. web_deployments  (Vercel)
-- -----------------------------------------------------------------------------
create table public.web_deployments (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  version_id            uuid not null,
  target                public.deployment_target not null default 'production',
  status                public.deployment_status not null default 'queued',
  vercel_deployment_id  text unique,
  url                   text,          -- https://<hash>.vercel.app
  alias_url             text,          -- https://{slug}.yourplatform.app
  inspector_url         text,
  error_code            text,
  error_message         text,
  triggered_by          uuid references public.profiles (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  ready_at              timestamptz,
  constraint web_deployments_version_fk foreign key (version_id, project_id)
    references public.project_versions (id, project_id) on delete cascade
);
create index web_deployments_project_created_idx on public.web_deployments (project_id, created_at desc);
create index web_deployments_version_idx on public.web_deployments (version_id);
-- Only one in-flight production deployment per project.
create unique index web_deployments_one_inflight_prod_uq
  on public.web_deployments (project_id)
  where target = 'production' and status in ('queued', 'building');

create trigger web_deployments_set_updated_at
  before update on public.web_deployments
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 10. domains  (Vercel Domains API)
-- -----------------------------------------------------------------------------
create table public.domains (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  hostname              text not null
                          check (char_length(hostname) between 4 and 253
                                 and hostname = lower(hostname)
                                 and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'),
  is_apex               boolean not null default false,
  redirect_to           text,         -- e.g. www.example.com -> example.com
  status                public.domain_status not null default 'pending',
  -- TXT challenge returned by Vercel when the domain is already used by another Vercel account
  verification_records  jsonb not null default '[]'::jsonb check (jsonb_typeof(verification_records) = 'array'),
  -- records to show the user, taken from Vercel's domain config response (recommended A / CNAME)
  dns_records           jsonb not null default '[]'::jsonb check (jsonb_typeof(dns_records) = 'array'),
  ssl_status            text not null default 'pending' check (ssl_status in ('pending', 'issued', 'failed')),
  misconfigured_reason  text,
  last_checked_at       timestamptz,
  verified_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index domains_project_idx on public.domains (project_id);
-- A hostname can be attached to only one live project platform-wide.
create unique index domains_hostname_live_uq on public.domains (hostname) where status <> 'removed';
-- Partial index for the periodic DNS re-check job.
create index domains_pending_check_idx on public.domains (last_checked_at nulls first)
  where status in ('pending', 'verifying', 'misconfigured');

create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 11. mobile_apps  (one per project per platform; identity in the stores)
-- -----------------------------------------------------------------------------
create table public.mobile_apps (
  id                      uuid primary key default gen_random_uuid(),
  -- RESTRICT: a project with a store app cannot be deleted until the app is
  -- removed from sale (otherwise it becomes an orphan on the platform account).
  project_id              uuid not null references public.projects (id) on delete restrict,
  platform                public.mobile_platform not null,
  -- intersection of Apple + Google rules: lowercase, digits, dots, >= 3 segments
  bundle_identifier       text not null
                            check (char_length(bundle_identifier) <= 150
                                   and bundle_identifier ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$'),
  -- store listing (editable by the owner through the Metadata Wizard)
  display_name            text not null check (char_length(display_name) between 2 and 30),
  subtitle                text check (char_length(subtitle) <= 30),             -- iOS
  short_description       text check (char_length(short_description) <= 80),    -- Google Play
  full_description        text check (char_length(full_description) <= 4000),
  keywords                text check (char_length(keywords) <= 100),            -- iOS
  category                text,
  privacy_policy_url      text check (privacy_policy_url ~ '^https://'),        -- required by both stores
  support_url             text check (support_url ~ '^https://'),
  marketing_url           text check (marketing_url ~ '^https://'),
  icon_path               text,
  -- store state (service_role only)
  store_app_id            text,       -- App Store Connect app id / Play package name
  store_url               text,
  listing_status          public.listing_status not null default 'draft',
  native_runtime_version  text,       -- runtimeVersion of the binary currently live in the store
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint mobile_apps_project_platform_uq unique (project_id, platform),
  constraint mobile_apps_platform_bundle_uq unique (platform, bundle_identifier),  -- same id on iOS + Android
  constraint mobile_apps_id_project_platform_uq unique (id, project_id, platform)
);

create trigger mobile_apps_set_updated_at
  before update on public.mobile_apps
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 12. mobile_builds  (EAS Build / Codemagic)
-- -----------------------------------------------------------------------------
create table public.mobile_builds (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null,
  mobile_app_id       uuid not null,
  platform            public.mobile_platform not null,
  version_id          uuid not null,
  build_provider      public.build_provider not null default 'eas',
  provider_build_id   text,
  build_profile       text not null default 'production',
  app_version         text not null check (app_version ~ '^\d{1,4}\.\d{1,4}\.\d{1,4}$'),  -- marketing version
  build_number        integer not null check (build_number between 1 and 2100000000),     -- assigned by trigger
  runtime_version     text not null,
  native_fingerprint  text,
  status              public.build_status not null default 'queued',
  artifact_path       text,           -- copy in bucket `build-artifacts` (provider URLs expire)
  logs_url            text,
  error_message       text,
  triggered_by        uuid references public.profiles (id) on delete set null,
  queued_at           timestamptz not null default now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint mobile_builds_provider_build_uq unique (build_provider, provider_build_id),
  constraint mobile_builds_app_build_number_uq unique (mobile_app_id, build_number),
  constraint mobile_builds_id_project_platform_uq unique (id, project_id, platform),
  constraint mobile_builds_app_fk foreign key (mobile_app_id, project_id, platform)
    references public.mobile_apps (id, project_id, platform) on delete cascade,
  constraint mobile_builds_version_fk foreign key (version_id, project_id)
    references public.project_versions (id, project_id)
);
create index mobile_builds_project_created_idx on public.mobile_builds (project_id, created_at desc);
create index mobile_builds_version_idx on public.mobile_builds (version_id);
create index mobile_builds_inflight_idx on public.mobile_builds (status) where status in ('queued', 'in_progress');

-- build_number (iOS CFBundleVersion / Android versionCode) must strictly increase per app.
create or replace function private.assign_build_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.mobile_apps where id = new.mobile_app_id for update;
  select coalesce(max(b.build_number), 0) + 1
    into new.build_number
    from public.mobile_builds b
   where b.mobile_app_id = new.mobile_app_id;
  return new;
end;
$$;

create trigger mobile_builds_assign_number
  before insert on public.mobile_builds
  for each row execute function private.assign_build_number();

create trigger mobile_builds_set_updated_at
  before update on public.mobile_builds
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 13. store_submissions  (EAS Submit / Fastlane -> App Store Connect / Play Console)
-- -----------------------------------------------------------------------------
create table public.store_submissions (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null,
  mobile_app_id           uuid not null,
  mobile_build_id         uuid not null,
  platform                public.mobile_platform not null,
  submit_provider         public.submit_provider not null default 'eas_submit',
  provider_submission_id  text,
  track                   text not null check (track in
                            ('internal', 'closed', 'open', 'production',   -- Google Play tracks
                             'testflight', 'app_store')),                 -- Apple
  status                  public.submission_status not null default 'queued',
  rejection_reason        text,
  rejection_guidelines    text[],     -- e.g. {'4.2','4.3(a)','5.1.1'}
  store_url               text,
  submitted_at            timestamptz,
  review_started_at       timestamptz,
  reviewed_at             timestamptz,
  published_at            timestamptz,
  status_history          jsonb not null default '[]'::jsonb check (jsonb_typeof(status_history) = 'array'),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint store_submissions_provider_uq unique (submit_provider, provider_submission_id),
  constraint store_submissions_track_platform_chk check (
    (platform = 'ios'     and track in ('testflight', 'app_store')) or
    (platform = 'android' and track in ('internal', 'closed', 'open', 'production'))),
  constraint store_submissions_build_fk foreign key (mobile_build_id, project_id, platform)
    references public.mobile_builds (id, project_id, platform) on delete cascade,
  constraint store_submissions_app_fk foreign key (mobile_app_id, project_id, platform)
    references public.mobile_apps (id, project_id, platform) on delete cascade
);
create index store_submissions_project_created_idx on public.store_submissions (project_id, created_at desc);
create index store_submissions_app_idx on public.store_submissions (mobile_app_id);
create index store_submissions_build_idx on public.store_submissions (mobile_build_id);
-- Poller for apps waiting on review.
create index store_submissions_pending_idx on public.store_submissions (updated_at)
  where status in ('submitting', 'submitted', 'in_review', 'approved');

-- Keep a timeline for the "Store Review Tracker" UI.
create or replace function private.track_submission_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_history := coalesce(new.status_history, '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object('status', new.status, 'at', now(), 'reason', new.rejection_reason));
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger store_submissions_track_status
  before insert or update on public.store_submissions
  for each row execute function private.track_submission_status();

-- -----------------------------------------------------------------------------
-- 14. ota_releases  (EAS Update / Capgo)
-- -----------------------------------------------------------------------------
create table public.ota_releases (
  id                        uuid primary key default gen_random_uuid(),
  project_id                uuid not null references public.projects (id) on delete cascade,
  version_id                uuid not null,
  provider                  public.ota_provider not null default 'eas_update',
  channel                   text not null default 'production' check (channel ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- MUST equal the runtimeVersion of a binary already in the store, otherwise
  -- the update is ignored by installed apps (or worse, crashes them).
  runtime_version           text not null,
  platforms                 public.mobile_platform[] not null default '{ios,android}'
                              check (cardinality(platforms) between 1 and 2),
  provider_update_group_id  text,       -- EAS update group id / Capgo bundle id
  bundle_hash               text,
  status                    public.ota_status not null default 'pending',
  rollout_percentage        smallint not null default 100 check (rollout_percentage between 1 and 100),
  is_rollback               boolean not null default false,
  rolled_back_release_id    uuid references public.ota_releases (id) on delete set null,
  message                   text check (char_length(message) <= 500),
  error_message             text,
  triggered_by              uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  published_at              timestamptz,
  constraint ota_releases_version_fk foreign key (version_id, project_id)
    references public.project_versions (id, project_id) on delete cascade,
  constraint ota_releases_provider_uq unique (provider, provider_update_group_id)
);
create index ota_releases_project_channel_idx on public.ota_releases (project_id, channel, created_at desc);
create index ota_releases_version_idx on public.ota_releases (version_id);
create index ota_releases_rolled_back_idx on public.ota_releases (rolled_back_release_id) where rolled_back_release_id is not null;

create trigger ota_releases_set_updated_at
  before update on public.ota_releases
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 15. Entitlement helper (used by API routes and UI)
-- -----------------------------------------------------------------------------
create or replace function public.can_publish_to_stores(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.projects p
     where p.id = p_project_id
       and (p.owner_id = (select auth.uid()) or (select auth.role()) = 'service_role')
       and (
         p.store_publishing_unlocked_at is not null
         or exists (
           select 1 from public.subscriptions s
            where s.user_id = p.owner_id
              and s.status in ('trialing', 'active')
              and s.includes_store_publishing
              and (s.current_period_end is null or s.current_period_end > now()))
       )
  );
$$;

-- =============================================================================
-- 16. Row Level Security
-- =============================================================================
alter table public.profiles             enable row level security;
alter table public.credit_transactions  enable row level security;
alter table public.subscriptions        enable row level security;
alter table public.projects             enable row level security;
alter table public.project_versions     enable row level security;
alter table public.web_deployments      enable row level security;
alter table public.domains              enable row level security;
alter table public.mobile_apps          enable row level security;
alter table public.mobile_builds        enable row level security;
alter table public.store_submissions    enable row level security;
alter table public.ota_releases         enable row level security;

-- profiles --------------------------------------------------------------------
create policy "profiles: read own"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- credit_transactions / subscriptions: read own, write service_role only ------
create policy "credit_transactions: read own"
  on public.credit_transactions for select to authenticated
  using (user_id = (select auth.uid()));

create policy "subscriptions: read own"
  on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- projects --------------------------------------------------------------------
create policy "projects: read own"
  on public.projects for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "projects: create own"
  on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "projects: update own"
  on public.projects for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "projects: delete own"
  on public.projects for delete to authenticated
  using (owner_id = (select auth.uid()));

-- child tables: read if you own the parent project ----------------------------
create policy "project_versions: read own project"
  on public.project_versions for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "web_deployments: read own project"
  on public.web_deployments for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "domains: read own project"
  on public.domains for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "mobile_apps: read own project"
  on public.mobile_apps for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "mobile_apps: edit listing of own project"
  on public.mobile_apps for update to authenticated
  using ((select private.owns_project(project_id)))
  with check ((select private.owns_project(project_id)));

create policy "mobile_builds: read own project"
  on public.mobile_builds for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "store_submissions: read own project"
  on public.store_submissions for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "ota_releases: read own project"
  on public.ota_releases for select to authenticated
  using ((select private.owns_project(project_id)));

-- =============================================================================
-- 17. Privileges (defence in depth on top of RLS)
--     Supabase grants ALL to anon/authenticated by default; tighten it.
-- =============================================================================
revoke all on
  public.profiles, public.credit_transactions, public.subscriptions, public.projects,
  public.project_versions, public.web_deployments, public.domains, public.mobile_apps,
  public.mobile_builds, public.store_submissions, public.ota_releases
from anon, authenticated;

grant select on
  public.profiles, public.credit_transactions, public.subscriptions, public.projects,
  public.project_versions, public.web_deployments, public.domains, public.mobile_apps,
  public.mobile_builds, public.store_submissions, public.ota_releases
to authenticated;

grant all on
  public.profiles, public.credit_transactions, public.subscriptions, public.projects,
  public.project_versions, public.web_deployments, public.domains, public.mobile_apps,
  public.mobile_builds, public.store_submissions, public.ota_releases
to service_role;
grant usage, select on all sequences in schema public to service_role;

-- user-editable columns only
grant update (full_name, avatar_url, locale) on public.profiles to authenticated;

grant insert (owner_id, name, slug, description, initial_prompt, app_config, icon_path)
  on public.projects to authenticated;
grant update (name, description, status, current_version_id, app_config, icon_path)
  on public.projects to authenticated;   -- current_version_id = 1-click rollback (FK keeps it in-project)
grant delete on public.projects to authenticated;

grant update (display_name, subtitle, short_description, full_description, keywords,
              category, privacy_policy_url, support_url, marketing_url, icon_path)
  on public.mobile_apps to authenticated;

-- functions
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.owns_project(uuid) to authenticated, service_role;

revoke all on function public.spend_credits(uuid, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.spend_credits(uuid, integer, text, jsonb) to service_role;

revoke all on function public.can_publish_to_stores(uuid) from public, anon;
grant execute on function public.can_publish_to_stores(uuid) to authenticated, service_role;

-- =============================================================================
-- 18. Realtime: live status in the dashboard (Realtime enforces RLS)
-- =============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.projects, public.web_deployments, public.domains,
      public.mobile_builds, public.store_submissions, public.ota_releases;
  end if;
end;
$$;
