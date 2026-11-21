-- بنّاء staging (banna-staging): الترحيلات 4 إلى 13 بالترتيب. تُشغَّل مرة واحدة في SQL Editor.
-- The first 3 migrations are already applied. Safe on this empty staging project only.


-- ============ 20261121130000_specs_billing_hosting_admin.sql ============
-- =============================================================================
-- T-02: platform schema for the approved design (docs/spec/02-design.md v1.0)
--   * customer-only publishers (FR-006, FR-006a)
--   * organizations + charity verification (FR-012c)
--   * app specs approved before generation (FR-002a, FR-002b)
--   * plans / Moyasar subscriptions / payments (FR-012, FR-012a, FR-012b)
--   * hosting mode + Saudi hosting requests (FR-005, FR-017, NFR-007)
--   * customer Moyasar accounts for generated apps (FR-014)
--   * code exports (FR-016), audit log + reports (FR-013)
-- Nothing here has been applied to a live project.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
create type public.org_kind                as enum ('business', 'charity');
create type public.verification_status     as enum ('unverified', 'pending', 'verified', 'rejected');
create type public.app_category            as enum ('store', 'restaurant', 'booking', 'directory', 'content', 'charity');
create type public.spec_status             as enum ('draft', 'approved', 'superseded');
create type public.hosting_mode            as enum ('standard', 'saudi');
create type public.hosting_request_status  as enum ('requested', 'quoted', 'paid', 'provisioning', 'migrating', 'active', 'canceled');
create type public.payment_purpose         as enum ('subscription', 'credits', 'hosting_setup', 'hosting_monthly');
create type public.payment_status          as enum ('initiated', 'paid', 'failed', 'refunded');
create type public.export_status           as enum ('queued', 'ready', 'failed', 'expired');
create type public.report_status           as enum ('open', 'reviewing', 'actioned', 'dismissed');

-- -----------------------------------------------------------------------------
-- 2. Admin helper (role lives in profiles.role, which users cannot update)
-- -----------------------------------------------------------------------------
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;

-- -----------------------------------------------------------------------------
-- 3. Publishers: customer accounts only, on both stores (FR-006, FR-006a)
-- -----------------------------------------------------------------------------
drop index if exists public.publisher_accounts_one_platform_android_uq;
alter table public.publisher_accounts
  add constraint publisher_accounts_customer_only_chk check (kind = 'customer'),
  add constraint publisher_accounts_google_fields_chk check (platform <> 'android' or play_developer_id is not null);
create unique index publisher_accounts_google_uq
  on public.publisher_accounts (owner_id, play_developer_id) where platform = 'android' and status <> 'revoked';

-- -----------------------------------------------------------------------------
-- 4. Organizations (FR-012c, donation eligibility)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.profiles (id) on delete cascade,
  kind                  public.org_kind not null,
  legal_name            text not null check (char_length(legal_name) between 2 and 200),
  license_number        text check (char_length(license_number) <= 60),   -- NCNP licence for charities
  document_path         text,                                             -- bucket project-assets: {owner_id}/org/...
  verification_status   public.verification_status not null default 'unverified',
  donations_eligible    boolean not null default false,                   -- set by an admin after review
  apple_nonprofit_approved boolean not null default false,                -- Apple's own approval (Guideline 3.2.1(vi))
  reviewed_by           uuid references public.profiles (id) on delete set null,
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint organizations_charity_licence_chk check (kind <> 'charity' or verification_status = 'unverified' or license_number is not null),
  constraint organizations_donations_chk check (not donations_eligible or (kind = 'charity' and verification_status = 'verified'))
);
create index organizations_owner_idx on public.organizations (owner_id);
create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Projects: category, organization, current spec
-- -----------------------------------------------------------------------------
alter table public.projects
  add column category         public.app_category,
  add column organization_id  uuid references public.organizations (id) on delete set null,
  add column current_spec_id  uuid;

create or replace function private.check_project_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is not null and not exists (
    select 1 from public.organizations o where o.id = new.organization_id and o.owner_id = new.owner_id
  ) then
    raise exception 'organization belongs to another user' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger projects_check_organization
  before insert or update of organization_id, owner_id on public.projects
  for each row execute function private.check_project_organization();

-- -----------------------------------------------------------------------------
-- 6. App specs (FR-002a/b). Approved specs are immutable.
-- -----------------------------------------------------------------------------
create table public.app_specs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  spec_number   integer not null check (spec_number > 0),          -- assigned by trigger
  parent_spec_id uuid,
  prompt        text check (char_length(prompt) <= 20000),
  content       jsonb not null check (jsonb_typeof(content) = 'object'),
  markdown      text not null check (char_length(markdown) <= 100000),
  status        public.spec_status not null default 'draft',
  created_by    uuid references public.profiles (id) on delete set null,
  approved_by   uuid references public.profiles (id) on delete set null,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint app_specs_number_uq unique (project_id, spec_number),
  constraint app_specs_id_project_uq unique (id, project_id),
  constraint app_specs_parent_fk foreign key (parent_spec_id, project_id)
    references public.app_specs (id, project_id) on delete set null (parent_spec_id),
  constraint app_specs_approval_chk check ((status = 'draft') = (approved_at is null))
);

create or replace function private.assign_spec_number()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.projects where id = new.project_id for update;
  select coalesce(max(s.spec_number), 0) + 1 into new.spec_number
    from public.app_specs s where s.project_id = new.project_id;
  return new;
end;
$$;
create trigger app_specs_assign_number before insert on public.app_specs
  for each row execute function private.assign_spec_number();

-- True when NEW differs from OLD only by FK columns being set to NULL (ON DELETE SET NULL).
create or replace function private.only_fk_nulled(p_old jsonb, p_new jsonb, p_cols text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_old - p_cols) = (p_new - p_cols)
     and not exists (
       select 1 from unnest(p_cols) c
        where (p_new -> c) is distinct from (p_old -> c) and (p_new -> c) <> 'null'::jsonb);
$$;

create or replace function private.protect_approved_spec()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.only_fk_nulled(to_jsonb(old), to_jsonb(new), array['created_by', 'approved_by', 'parent_spec_id']) then
    return new;                                  -- referenced profile/spec deleted
  end if;
  if old.status = 'draft' then
    return new;                                  -- drafts are editable; approval sets approved_at
  end if;
  -- approved/superseded: only approved -> superseded is allowed, nothing else changes
  if old.status = 'approved' and new.status = 'superseded'
     and new.content = old.content and new.markdown = old.markdown and new.approved_at = old.approved_at then
    return new;
  end if;
  raise exception 'approved specs are immutable' using errcode = '55000';
end;
$$;
create trigger app_specs_protect before update on public.app_specs
  for each row execute function private.protect_approved_spec();

-- one approved spec per project at a time
create unique index app_specs_one_approved_uq on public.app_specs (project_id) where status = 'approved';

alter table public.projects
  add constraint projects_current_spec_fk foreign key (current_spec_id, id)
    references public.app_specs (id, project_id) on delete set null (current_spec_id);

alter table public.project_versions
  add column spec_id uuid,
  add constraint project_versions_spec_fk foreign key (spec_id, project_id)
    references public.app_specs (id, project_id) on delete set null (spec_id);

-- Immutability triggers from the core migration blocked legitimate cascades:
-- deleting a user (UC-13) failed on the credit ledger and on project_versions.created_by.
create or replace function private.protect_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.only_fk_nulled(to_jsonb(old), to_jsonb(new), array['created_by', 'spec_id', 'parent_version_id']) then
    return new;
  end if;
  raise exception 'project_versions is append-only' using errcode = '42501';
end;
$$;
drop trigger project_versions_immutable on public.project_versions;
create trigger project_versions_immutable before update on public.project_versions
  for each row execute function private.protect_version();

create or replace function private.protect_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- rows may only disappear together with their owner (account deletion cascade)
  if tg_op = 'DELETE' and not exists (select 1 from public.profiles where id = old.user_id) then
    return old;
  end if;
  raise exception 'credit_transactions is append-only' using errcode = '42501';
end;
$$;
drop trigger credit_transactions_no_update on public.credit_transactions;
create trigger credit_transactions_no_update before update or delete on public.credit_transactions
  for each row execute function private.protect_ledger();

-- -----------------------------------------------------------------------------
-- 7. Plans, subscriptions, payments (FR-012*). Prices are data, editable by admins.
-- -----------------------------------------------------------------------------
create table public.plans (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_ar             text not null,
  name_en             text not null,
  price_halalas       integer not null check (price_halalas >= 0),        -- 100 halalas = 1 SAR
  billing_interval    text check (billing_interval in ('month', 'year')), -- null = one-off (credit pack)
  monthly_credits     integer not null default 0 check (monthly_credits >= 0),
  max_published_apps  integer not null default 0 check (max_published_apps >= 0),
  features            jsonb not null default '{}'::jsonb,                  -- {custom_domain, code_export, stores}
  charity_discount_pct integer not null default 0 check (charity_discount_pct between 0 and 100),
  is_active           boolean not null default true,
  sort_order          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger plans_set_updated_at before update on public.plans
  for each row execute function private.set_updated_at();

-- Proposed prices (docs/spec/03-build-log.md); change from the admin panel.
insert into public.plans (code, name_ar, name_en, price_halalas, billing_interval, monthly_credits, max_published_apps, features, charity_discount_pct, sort_order) values
  ('free',      'مجانية',     'Free',       0,     null,    0,   0, '{"stores":false,"custom_domain":false,"code_export":false}', 0,  0),
  ('basic',     'أساسية',     'Basic',      9900,  'month', 100, 1, '{"stores":true,"custom_domain":false,"code_export":false}',  50, 1),
  ('pro',       'احترافية',   'Pro',        24900, 'month', 300, 3, '{"stores":true,"custom_domain":true,"code_export":true}',    50, 2),
  ('credits_50','رصيد إضافي', 'Credit pack', 4900, null,    50,  0, '{"credit_pack":true}',                                      0,  10);

alter table public.subscriptions
  add column plan_id           uuid references public.plans (id),
  add column moyasar_token_id  text,           -- saved-card token id (no card data)
  add column next_charge_at    timestamptz,
  add column failed_attempts   integer not null default 0 check (failed_attempts between 0 and 10),
  add column grace_until       timestamptz;

create table public.payments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles (id) on delete cascade,
  provider             public.payment_provider not null default 'moyasar',
  provider_payment_id  text,
  purpose              public.payment_purpose not null,
  plan_id              uuid references public.plans (id),
  reference_id         uuid,                                   -- subscription / hosting request id
  amount_halalas       integer not null check (amount_halalas > 0),
  currency             text not null default 'SAR' check (currency = 'SAR'),
  status               public.payment_status not null default 'initiated',
  failure_reason       text,
  metadata             jsonb not null default '{}'::jsonb,     -- never card data
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payments_provider_uq unique (provider, provider_payment_id)
);
create index payments_user_idx on public.payments (user_id, created_at desc);
create trigger payments_set_updated_at before update on public.payments
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 8. App backends: hosting mode (FR-005, FR-017)
-- -----------------------------------------------------------------------------
alter table public.app_backends
  add column hosting       public.hosting_mode not null default 'standard',
  add column cell_app_id   text,                       -- id inside the Saudi cell
  alter column organization_slug drop not null,
  alter column region_code drop not null,
  add constraint app_backends_mode_chk check (
    (hosting = 'standard' and organization_slug is not null) or
    (hosting = 'saudi' and cell_app_id is not null) or
    status = 'provisioning');

create table public.hosting_requests (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id) on delete cascade,
  requested_by            uuid references public.profiles (id) on delete set null,
  region                  text not null default 'sa' check (region = 'sa'),
  setup_fee_halalas       integer check (setup_fee_halalas >= 0),
  monthly_fee_halalas     integer check (monthly_fee_halalas >= 0),
  setup_payment_id        uuid references public.payments (id),
  status                  public.hosting_request_status not null default 'requested',
  note                    text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create unique index hosting_requests_one_open_uq on public.hosting_requests (project_id)
  where status not in ('active', 'canceled');
create trigger hosting_requests_set_updated_at before update on public.hosting_requests
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 9. Customer Moyasar accounts for generated apps (FR-014).
--    The SECRET key is written to the app's own backend vault, never here.
-- -----------------------------------------------------------------------------
create table public.app_payment_accounts (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null unique references public.projects (id) on delete cascade,
  provider          text not null default 'moyasar' check (provider = 'moyasar'),
  publishable_key   text not null check (publishable_key ~ '^pk_(live|test)_[A-Za-z0-9]+$'),
  secret_stored_at  timestamptz,
  status            text not null default 'pending' check (status in ('pending', 'active', 'invalid')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger app_payment_accounts_set_updated_at before update on public.app_payment_accounts
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- 10. Code exports (FR-016)
-- -----------------------------------------------------------------------------
create table public.code_exports (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  version_id     uuid not null,
  requested_by   uuid references public.profiles (id) on delete set null,
  status         public.export_status not null default 'queued',
  storage_path   text,                          -- bucket code-exports (service only; signed URLs)
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  constraint code_exports_version_fk foreign key (version_id, project_id)
    references public.project_versions (id, project_id) on delete cascade
);
create index code_exports_project_idx on public.code_exports (project_id, created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('code-exports', 'code-exports', false, 52428800, array['application/zip'])
on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 11. Audit log (append-only) and content reports (FR-013)
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles (id) on delete set null,
  action       text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),   -- e.g. project.suspend
  target_type  text not null,
  target_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index audit_log_target_idx on public.audit_log (target_type, target_id, at desc);

create or replace function private.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- the only permitted change: ON DELETE SET NULL of actor_id when a profile is deleted
  if tg_op = 'UPDATE' and new.actor_id is null and old.actor_id is not null
     and (new.action, new.target_type, new.target_id, new.metadata, new.at)
         is not distinct from (old.action, old.target_type, old.target_id, old.metadata, old.at) then
    return new;
  end if;
  raise exception 'audit_log is append-only' using errcode = '55000';
end;
$$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function private.audit_log_append_only();

create table public.reports (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  reporter_email  text check (char_length(reporter_email) <= 320),
  reason          text not null check (reason in ('illegal', 'fraud', 'abuse', 'privacy', 'copyright', 'other')),
  details         text check (char_length(details) <= 4000),
  status          public.report_status not null default 'open',
  handled_by      uuid references public.profiles (id) on delete set null,
  handled_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index reports_open_idx on public.reports (status, created_at) where status in ('open', 'reviewing');

-- -----------------------------------------------------------------------------
-- 12. RLS
-- -----------------------------------------------------------------------------
alter table public.organizations        enable row level security;
alter table public.app_specs            enable row level security;
alter table public.plans                enable row level security;
alter table public.payments             enable row level security;
alter table public.hosting_requests     enable row level security;
alter table public.app_payment_accounts enable row level security;
alter table public.code_exports         enable row level security;
alter table public.audit_log            enable row level security;
alter table public.reports              enable row level security;

create policy "organizations: read own" on public.organizations for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "organizations: create own" on public.organizations for insert to authenticated
  with check (owner_id = (select auth.uid()) and verification_status = 'unverified' and not donations_eligible);

create policy "app_specs: read own project" on public.app_specs for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "plans: read active" on public.plans for select to anon, authenticated
  using (is_active);

create policy "payments: read own" on public.payments for select to authenticated
  using (user_id = (select auth.uid()));

create policy "hosting_requests: read own project" on public.hosting_requests for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "app_payment_accounts: read own project" on public.app_payment_accounts for select to authenticated
  using ((select private.owns_project(project_id)));

create policy "code_exports: read own project" on public.code_exports for select to authenticated
  using ((select private.owns_project(project_id)));

-- audit_log and reports: no user policies (server + admin API only)

-- -----------------------------------------------------------------------------
-- 13. Privileges
-- -----------------------------------------------------------------------------
revoke all on public.organizations, public.app_specs, public.plans, public.payments, public.hosting_requests,
  public.app_payment_accounts, public.code_exports, public.audit_log, public.reports from anon, authenticated;

grant select on public.organizations, public.app_specs, public.payments, public.hosting_requests,
  public.app_payment_accounts, public.code_exports to authenticated;
grant select on public.plans to anon, authenticated;
grant insert (owner_id, kind, legal_name, license_number, document_path) on public.organizations to authenticated;

-- projects: category / organization are user-chosen; current_spec_id is server-only
grant insert (category, organization_id) on public.projects to authenticated;
grant update (category, organization_id) on public.projects to authenticated;

grant all on public.organizations, public.app_specs, public.plans, public.payments, public.hosting_requests,
  public.app_payment_accounts, public.code_exports, public.reports to service_role;
grant select, insert on public.audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated, service_role;
revoke all on function private.check_project_organization() from public, anon, authenticated;
revoke all on function private.assign_spec_number() from public, anon, authenticated;
revoke all on function private.protect_approved_spec() from public, anon, authenticated;
revoke all on function private.audit_log_append_only() from public, anon, authenticated;
revoke all on function private.protect_version() from public, anon, authenticated;
revoke all on function private.protect_ledger() from public, anon, authenticated;
-- pure helper called from triggers, so every role that can write must be able to run it
grant execute on function private.only_fk_nulled(jsonb, jsonb, text[]) to anon, authenticated, service_role;

-- Realtime: spec drafts appear live while the AI writes them
alter publication supabase_realtime add table public.app_specs, public.hosting_requests, public.code_exports;


-- ============ 20261121140000_spec_workflow.sql ============
-- T-05: writing and approving specs (FR-002a, design §5.1 and §6).
-- Both entry points are atomic: credits, state changes and the follow-up job
-- commit together or not at all, so a failure never leaves a charge without work.

-- -----------------------------------------------------------------------------
-- start_spec_draft: charge credits and queue the spec.draft job
-- -----------------------------------------------------------------------------
create or replace function public.start_spec_draft(
  p_project_id uuid,
  p_user_id    uuid,
  p_cost       integer,
  p_payload    jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job bigint;
  v_ref text := 'spec_draft:' || gen_random_uuid()::text;
begin
  -- one draft at a time per project: the project row lock serialises concurrent requests
  perform 1 from public.projects where id = p_project_id and owner_id = p_user_id for update;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.jobs
              where dedupe_key = 'spec.draft:' || p_project_id and status in ('queued', 'running')) then
    raise exception 'draft_in_progress' using errcode = 'P0001';
  end if;

  if p_cost > 0 then
    perform public.spend_credits(p_user_id, p_cost, v_ref, jsonb_build_object('project_id', p_project_id));
  end if;

  v_job := public.enqueue_job(
    'spec.draft',
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
      'projectId', p_project_id, 'userId', p_user_id, 'creditRef', v_ref, 'cost', p_cost),
    p_project_id,
    'spec.draft:' || p_project_id,
    now(),
    3);
  return v_job;
end;
$$;

-- -----------------------------------------------------------------------------
-- approve_spec: supersede the old spec, approve the draft, point the project
-- at it, charge the generation and queue app.generate (T-06 runs it).
-- -----------------------------------------------------------------------------
create or replace function public.approve_spec(
  p_spec_id uuid,
  p_user_id uuid,
  p_cost    integer
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spec    public.app_specs%rowtype;
  v_project public.projects%rowtype;
  v_job     bigint;
begin
  select * into v_spec from public.app_specs where id = p_spec_id;
  if not found then
    raise exception 'spec_not_found' using errcode = 'P0002';
  end if;

  select * into v_project from public.projects
   where id = v_spec.project_id and owner_id = p_user_id for update;
  if not found then
    raise exception 'spec_not_found' using errcode = 'P0002';
  end if;

  -- re-read under the project lock: a concurrent approval may have won
  select * into v_spec from public.app_specs where id = p_spec_id;
  if v_spec.status <> 'draft' then
    raise exception 'spec_locked' using errcode = 'P0001';
  end if;
  if v_project.status = 'generating' or exists (
       select 1 from public.jobs
        where dedupe_key = 'app.generate:' || v_project.id and status in ('queued', 'running')) then
    raise exception 'generation_in_progress' using errcode = 'P0001';
  end if;

  if p_cost > 0 then
    perform public.spend_credits(p_user_id, p_cost, 'generate:' || p_spec_id,
      jsonb_build_object('project_id', v_project.id, 'spec_id', p_spec_id));
  end if;

  update public.app_specs set status = 'superseded'
   where project_id = v_project.id and status = 'approved';

  update public.app_specs
     set status = 'approved', approved_at = now(), approved_by = p_user_id
   where id = p_spec_id;

  update public.projects set current_spec_id = p_spec_id where id = v_project.id;

  v_job := public.enqueue_job(
    'app.generate',
    jsonb_build_object('projectId', v_project.id, 'specId', p_spec_id, 'userId', p_user_id,
                       'cost', p_cost, 'creditRef', 'generate:' || p_spec_id),
    v_project.id,
    'app.generate:' || v_project.id,
    now(),
    3);
  return v_job;
end;
$$;

revoke all on function public.start_spec_draft(uuid, uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.approve_spec(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.start_spec_draft(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.approve_spec(uuid, uuid, integer) to service_role;


-- ============ 20261121150000_google_play_publisher.sql ============
-- T-09: Google Play on the customer's own account (FR-006a, FR-006b).
-- Google requires new PERSONAL developer accounts (created on/after 2023-11-13) to run a
-- closed test with at least 12 opted-in testers for 14 continuous days, then apply for
-- production access in Play Console. The platform cannot check that through the API,
-- so the owner confirms it; until then releases go to the closed track.

alter table public.publisher_accounts
  add column play_account_type      text check (play_account_type in ('personal', 'organization')),
  add column play_account_created_on date,
  add column play_production_access boolean not null default false,
  add constraint publisher_accounts_play_type_chk check (platform <> 'android' or play_account_type is not null);

create or replace function public.play_needs_closed_test(p_publisher_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p.platform = 'android'
       and p.play_account_type = 'personal'
       and (p.play_account_created_on is null or p.play_account_created_on >= date '2023-11-13')
       and not p.play_production_access
      from public.publisher_accounts p
     where p.id = p_publisher_id
       and (p.owner_id = (select auth.uid()) or (select auth.role()) = 'service_role')), false);
$$;
revoke all on function public.play_needs_closed_test(uuid) from public, anon;
grant execute on function public.play_needs_closed_test(uuid) to authenticated, service_role;

alter table public.mobile_apps
  add column play_closed_test_started_at timestamptz;   -- first release on the closed track

grant select (play_account_type, play_account_created_on, play_production_access) on public.publisher_accounts to authenticated;


-- ============ 20261121160000_billing.sql ============
-- T-10: billing with Moyasar (FR-012, FR-012a/b/c, design §5.6, ADR-006).
-- Moyasar has no managed subscriptions, so the platform renews monthly with the
-- saved card token. Every money movement is settled here, in one transaction,
-- and settling the same payment twice is a no-op.

-- -----------------------------------------------------------------------------
-- Price for a user: verified charities get the plan's charity discount (FR-012c).
-- -----------------------------------------------------------------------------
create or replace function public.plan_price_for(p_user_id uuid, p_plan_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when exists (select 1 from public.organizations o
                         where o.owner_id = p_user_id and o.kind = 'charity' and o.verification_status = 'verified')
           then (p.price_halalas * (100 - p.charity_discount_pct) / 100)
           else p.price_halalas
         end
    from public.plans p
   where p.id = p_plan_id;
$$;

-- -----------------------------------------------------------------------------
-- settle_platform_payment: apply a confirmed Moyasar payment exactly once.
-- -----------------------------------------------------------------------------
create or replace function public.settle_platform_payment(
  p_payment_id          uuid,
  p_provider_payment_id text,
  p_amount              integer,
  p_token               text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay   public.payments%rowtype;
  v_plan  public.plans%rowtype;
  v_sub   public.subscriptions%rowtype;
  v_start timestamptz;
begin
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  if v_pay.status = 'paid' then
    return 'already_settled';
  end if;
  if v_pay.status <> 'initiated' then
    raise exception 'payment_not_open' using errcode = 'P0001';
  end if;
  if p_amount is distinct from v_pay.amount_halalas then
    update public.payments set status = 'failed', failure_reason = 'amount_mismatch', provider_payment_id = p_provider_payment_id
     where id = p_payment_id;
    return 'amount_mismatch';
  end if;

  update public.payments set status = 'paid', provider_payment_id = p_provider_payment_id where id = p_payment_id;

  if v_pay.purpose = 'credits' then
    select * into v_plan from public.plans where id = v_pay.plan_id;
    insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
    values (v_pay.user_id, v_plan.monthly_credits, 'purchase', p_payment_id::text, jsonb_build_object('plan', v_plan.code));
    return 'credits_added';
  end if;

  if v_pay.purpose = 'subscription' then
    select * into v_plan from public.plans where id = v_pay.plan_id;
    select * into v_sub from public.subscriptions
     where user_id = v_pay.user_id and status in ('trialing', 'active', 'past_due') for update;

    -- a renewal continues from the end of the paid period; a new plan starts now
    v_start := case when found and v_sub.plan_id = v_plan.id and v_sub.current_period_end > now()
                    then v_sub.current_period_end else now() end;

    if found then
      update public.subscriptions
         set plan_id = v_plan.id,
             plan = case when v_plan.code = 'pro' then 'pro'::public.plan_tier else 'starter'::public.plan_tier end,
             status = 'active',
             includes_store_publishing = coalesce((v_plan.features ->> 'stores')::boolean, false),
             monthly_credits = v_plan.monthly_credits,
             current_period_start = v_start,
             current_period_end = v_start + interval '1 month',
             next_charge_at = v_start + interval '1 month',
             moyasar_token_id = coalesce(p_token, v_sub.moyasar_token_id),
             failed_attempts = 0,
             grace_until = null,
             cancel_at_period_end = false
       where id = v_sub.id;
    else
      insert into public.subscriptions (user_id, provider, plan, plan_id, status, billing_interval,
                                        includes_store_publishing, monthly_credits,
                                        current_period_start, current_period_end, next_charge_at, moyasar_token_id)
      values (v_pay.user_id, 'moyasar',
              case when v_plan.code = 'pro' then 'pro'::public.plan_tier else 'starter'::public.plan_tier end,
              v_plan.id, 'active', 'month',
              coalesce((v_plan.features ->> 'stores')::boolean, false), v_plan.monthly_credits,
              v_start, v_start + interval '1 month', v_start + interval '1 month', p_token);
    end if;

    insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
    select v_pay.user_id, v_plan.monthly_credits, 'subscription_grant', p_payment_id::text, jsonb_build_object('plan', v_plan.code)
     where v_plan.monthly_credits > 0;
    return 'subscription_active';
  end if;

  if v_pay.purpose = 'hosting_setup' then
    update public.hosting_requests set status = 'paid', setup_payment_id = p_payment_id
     where id = v_pay.reference_id and status in ('requested', 'quoted');
    return 'hosting_paid';
  end if;

  return 'paid';
end;
$$;

-- -----------------------------------------------------------------------------
-- Renewal failures: 3 attempts over 7 days (day 0, +3, +7), then 14 days of grace
-- for published apps, then the subscription expires (design §5.6).
-- -----------------------------------------------------------------------------
create or replace function public.record_renewal_failure(p_subscription_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  update public.subscriptions
     set failed_attempts = failed_attempts + 1,
         metadata = metadata || jsonb_build_object('last_failure', left(coalesce(p_reason, ''), 300))
   where id = p_subscription_id and status in ('active', 'trialing', 'past_due')
  returning failed_attempts into v_attempts;
  if v_attempts is null then
    return 'not_live';
  end if;
  if v_attempts < 3 then
    update public.subscriptions
       set next_charge_at = now() + case v_attempts when 1 then interval '3 days' else interval '4 days' end
     where id = p_subscription_id;
    return 'retry_scheduled';
  end if;
  update public.subscriptions
     set status = 'past_due', next_charge_at = null, grace_until = now() + interval '14 days'
   where id = p_subscription_id;
  return 'grace_started';
end;
$$;

-- Ends subscriptions whose grace period is over; returns their users so the
-- worker can suspend their apps' backends (data kept 90 days, never deleted here).
create or replace function public.expire_lapsed_subscriptions()
returns table (user_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.subscriptions s
     set status = 'expired', canceled_at = now()
   where s.status = 'past_due' and s.grace_until is not null and s.grace_until <= now()
  returning s.user_id;
$$;

-- Subscriptions due for renewal (period over, card saved, not set to cancel).
create or replace function public.due_renewals(p_limit integer default 50)
returns table (subscription_id uuid, user_id uuid, plan_id uuid, token text, amount integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.user_id, s.plan_id, s.moyasar_token_id, public.plan_price_for(s.user_id, s.plan_id)
    from public.subscriptions s
   where s.status in ('active', 'trialing')
     and s.provider = 'moyasar'
     and s.next_charge_at is not null and s.next_charge_at <= now()
     and not s.cancel_at_period_end
     and s.moyasar_token_id is not null and s.plan_id is not null
   order by s.next_charge_at
   limit p_limit;
$$;

-- canceling at period end: the last paid period runs out, then the plan is free
create or replace function public.end_canceled_subscriptions()
returns integer
language sql
security definer
set search_path = ''
as $$
  with ended as (
    update public.subscriptions
       set status = 'canceled', canceled_at = now(), next_charge_at = null
     where status in ('active', 'trialing') and cancel_at_period_end and current_period_end <= now()
    returning 1)
  select count(*)::int from ended;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.plan_price_for(uuid, uuid)',
    'public.settle_platform_payment(uuid, text, integer, text)',
    'public.record_renewal_failure(uuid, text)',
    'public.expire_lapsed_subscriptions()',
    'public.due_renewals(integer)',
    'public.end_canceled_subscriptions()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- at most one open or paid renewal per subscription period (retries come after a failure)
create unique index if not exists payments_renewal_uq on public.payments (reference_id, ((metadata ->> 'period_end')))
  where purpose = 'subscription' and metadata ? 'period_end' and status in ('initiated', 'paid');


-- ============ 20261121170000_app_payment_secret.sql ============
-- T-11: the app owner's Moyasar secret key (FR-014).
-- It belongs in the app's own backend (an Edge Function secret). If the backend does not
-- exist yet (it is created at the first paid publish), the key waits in the platform Vault
-- and is moved, then deleted here, during provisioning. Users can never read its id.

alter table public.app_payment_accounts
  add column pending_secret_id uuid,
  add column key_mode text check (key_mode in ('test', 'live'));

revoke select on public.app_payment_accounts from authenticated;
grant select (id, project_id, provider, publishable_key, secret_stored_at, status, key_mode, created_at, updated_at)
  on public.app_payment_accounts to authenticated;


-- ============ 20261121180000_organizations.sql ============
-- T-13: organizations and charity verification (FR-012c, design §5.6 and §7).
-- One organization per account. A charity sends its NCNP licence and a document;
-- an admin verifies it. Verification turns on the plan's charity discount
-- (plan_price_for, from the next payment or renewal) and, if the admin allows it,
-- donations inside the charity's apps. Every decision is written to audit_log.

-- private bucket; the server uploads on the owner's behalf and admins read through signed URLs
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('org-documents', 'org-documents', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do nothing;

create unique index if not exists organizations_one_per_owner on public.organizations (owner_id);

-- writes go through submit_organization only (status and review fields are never the user's)
revoke insert on public.organizations from authenticated;
drop policy if exists "organizations: create own" on public.organizations;

create or replace function public.submit_organization(
  p_user_id       uuid,
  p_kind          public.org_kind,
  p_legal_name    text,
  p_license       text,
  p_document_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     public.organizations%rowtype;
  v_license text := nullif(btrim(coalesce(p_license, '')), '');
  v_doc     text;
  v_id      uuid;
begin
  if p_document_path is not null and p_document_path not like p_user_id::text || '/%' then
    raise exception 'invalid_document' using errcode = '22023';
  end if;

  select * into v_org from public.organizations where owner_id = p_user_id for update;
  v_doc := coalesce(p_document_path, v_org.document_path);

  if p_kind = 'charity' and v_license is null then
    raise exception 'license_required' using errcode = '22023';
  end if;
  if p_kind = 'charity' and v_doc is null then
    raise exception 'document_required' using errcode = '22023';
  end if;

  -- nothing changed on a reviewed organization: keep its decision
  if found and v_org.kind = p_kind and v_org.legal_name = btrim(p_legal_name)
     and v_org.license_number is not distinct from v_license and p_document_path is null
     and v_org.verification_status in ('verified', 'pending') then
    return v_org.id;
  end if;

  insert into public.organizations (owner_id, kind, legal_name, license_number, document_path, verification_status)
  values (p_user_id, p_kind, btrim(p_legal_name), v_license, v_doc,
          case when p_kind = 'charity' then 'pending' else 'unverified' end::public.verification_status)
  on conflict (owner_id) do update
     set kind = excluded.kind,
         legal_name = excluded.legal_name,
         license_number = excluded.license_number,
         document_path = excluded.document_path,
         verification_status = excluded.verification_status,
         donations_eligible = false,          -- any change needs a new review
         reviewed_by = null, reviewed_at = null, review_note = null
  returning id into v_id;

  -- the account's projects belong to its organization (spec review reads it from there)
  update public.projects set organization_id = v_id where owner_id = p_user_id and organization_id is distinct from v_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'organization.submit', 'organization', v_id::text, jsonb_build_object('kind', p_kind));
  return v_id;
end;
$$;

-- p_approve true: verify (pending only). false: reject a pending one, or revoke a verified one.
create or replace function public.review_organization(
  p_org_id     uuid,
  p_admin_id   uuid,
  p_approve    boolean,
  p_donations  boolean,
  p_note       text
)
returns public.verification_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_status public.verification_status;
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;
  if v_org.kind <> 'charity'
     or (p_approve and v_org.verification_status <> 'pending')
     or (not p_approve and v_org.verification_status not in ('pending', 'verified')) then
    raise exception 'not_reviewable' using errcode = 'P0001';
  end if;
  if not p_approve and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'note_required' using errcode = '22023';   -- the owner is told why
  end if;

  v_status := case when p_approve then 'verified' else 'rejected' end;
  update public.organizations
     set verification_status = v_status,
         donations_eligible = p_approve and coalesce(p_donations, false),
         reviewed_by = p_admin_id, reviewed_at = now(),
         review_note = left(nullif(btrim(coalesce(p_note, '')), ''), 1000)
   where id = p_org_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id,
          case when p_approve then 'organization.verify'
               when v_org.verification_status = 'verified' then 'organization.revoke'
               else 'organization.reject' end,
          'organization', p_org_id::text,
          jsonb_build_object('donations', p_approve and coalesce(p_donations, false), 'owner', v_org.owner_id));
  return v_status;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.submit_organization(uuid, public.org_kind, text, text, text)',
    'public.review_organization(uuid, uuid, boolean, boolean, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============ 20261121190000_saudi_hosting.sql ============
-- T-14: in-Kingdom hosting requests (FR-017, design §3.3 and §5.2).
-- Flow: the owner requests → an admin quotes (setup + monthly fee; the first ever
-- request also covers setting up the cell, told before payment) → the owner pays the
-- setup fee (settle_platform_payment marks the request paid) → the backend is created
-- in the cell at the next publish, or an admin migrates an existing one.
-- The monthly fee is added to the owner's plan renewal once the hosting is active.

create or replace function public.request_saudi_hosting(p_project_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform 1 from public.projects where id = p_project_id and owner_id = p_user_id for update;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  select id into v_id from public.hosting_requests
   where project_id = p_project_id and status not in ('active', 'canceled');
  if v_id is not null then
    return v_id;                                   -- one open request per app
  end if;
  if exists (select 1 from public.hosting_requests where project_id = p_project_id and status = 'active') then
    raise exception 'already_saudi' using errcode = 'P0001';
  end if;
  insert into public.hosting_requests (project_id, requested_by) values (p_project_id, p_user_id) returning id into v_id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'hosting.request', 'project', p_project_id::text, jsonb_build_object('request', v_id));
  return v_id;
end;
$$;

create or replace function public.quote_hosting_request(
  p_request_id uuid, p_admin_id uuid, p_setup_halalas integer, p_monthly_halalas integer, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_setup_halalas is null or p_setup_halalas < 100 or p_monthly_halalas is null or p_monthly_halalas < 0 then
    raise exception 'invalid_quote' using errcode = '22023';
  end if;
  update public.hosting_requests
     set setup_fee_halalas = p_setup_halalas, monthly_fee_halalas = p_monthly_halalas,
         note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000), status = 'quoted'
   where id = p_request_id and status in ('requested', 'quoted');
  if not found then
    raise exception 'not_quotable' using errcode = 'P0001';
  end if;
  -- an unpaid payment for an older quote can no longer be settled
  update public.payments set status = 'failed', failure_reason = 'quote_changed'
   where reference_id = p_request_id and purpose = 'hosting_setup' and status = 'initiated';
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id, 'hosting.quote', 'hosting_request', p_request_id::text,
          jsonb_build_object('setup', p_setup_halalas, 'monthly', p_monthly_halalas));
end;
$$;

-- Opens (or reuses) the setup-fee payment for a quoted request. The amount comes from the quote only.
create or replace function public.open_hosting_payment(p_request_id uuid, p_user_id uuid)
returns table (payment_id uuid, amount integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req public.hosting_requests%rowtype;
begin
  select hr.* into v_req from public.hosting_requests hr
    join public.projects p on p.id = hr.project_id
   where hr.id = p_request_id and p.owner_id = p_user_id
   for update of hr;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'quoted' then
    raise exception 'not_payable' using errcode = 'P0001';
  end if;
  return query
    select py.id, py.amount_halalas from public.payments py
     where py.reference_id = p_request_id and py.purpose = 'hosting_setup' and py.status = 'initiated'
       and py.amount_halalas = v_req.setup_fee_halalas and py.user_id = p_user_id
     order by py.created_at desc limit 1;
  if found then
    return;
  end if;
  return query
    insert into public.payments (user_id, purpose, reference_id, amount_halalas, metadata)
    values (p_user_id, 'hosting_setup', p_request_id, v_req.setup_fee_halalas,
            jsonb_build_object('project', v_req.project_id, 'monthly', v_req.monthly_fee_halalas))
    returning id, amount_halalas;
end;
$$;

create or replace function public.cancel_hosting_request(p_request_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.hosting_requests hr set status = 'canceled'
    from public.projects p
   where hr.id = p_request_id and p.id = hr.project_id and p.owner_id = p_user_id
     and hr.status in ('requested', 'quoted');
  if not found then
    raise exception 'not_cancelable' using errcode = 'P0001';   -- paid requests are refunded by an admin
  end if;
  update public.payments set status = 'failed', failure_reason = 'request_canceled'
   where reference_id = p_request_id and purpose = 'hosting_setup' and status = 'initiated';
end;
$$;

-- Monthly in-Kingdom fees ride on the plan renewal (one card charge a month).
create or replace function public.hosting_monthly_for(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(hr.monthly_fee_halalas), 0)::int
    from public.hosting_requests hr
    join public.projects p on p.id = hr.project_id
   where p.owner_id = p_user_id and hr.status = 'active';
$$;

create or replace function public.due_renewals(p_limit integer default 50)
returns table (subscription_id uuid, user_id uuid, plan_id uuid, token text, amount integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.user_id, s.plan_id, s.moyasar_token_id,
         public.plan_price_for(s.user_id, s.plan_id) + public.hosting_monthly_for(s.user_id)
    from public.subscriptions s
   where s.status in ('active', 'trialing')
     and s.provider = 'moyasar'
     and s.next_charge_at is not null and s.next_charge_at <= now()
     and not s.cancel_at_period_end
     and s.moyasar_token_id is not null and s.plan_id is not null
   order by s.next_charge_at
   limit p_limit;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.request_saudi_hosting(uuid, uuid)',
    'public.quote_hosting_request(uuid, uuid, integer, integer, text)',
    'public.open_hosting_payment(uuid, uuid)',
    'public.cancel_hosting_request(uuid, uuid)',
    'public.hosting_monthly_for(uuid)',
    'public.due_renewals(integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============ 20261121200000_admin.sql ============
-- T-15: admin panel (FR-013, design §7). Admins act on accounts, apps and reports;
-- they never read the end-user data inside apps. Every action goes to audit_log.

-- An admin suspension is separate from a billing pause: paying again must not lift it.
alter table public.projects
  add column suspended_at       timestamptz,
  add column suspension_reason  text check (char_length(suspension_reason) <= 500);

create or replace function private.assert_admin(p_admin_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.admin_suspend_project(p_project_id uuid, p_admin_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 500);
  v_backend public.app_backends%rowtype;
begin
  perform private.assert_admin(p_admin_id);
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  update public.projects set suspended_at = coalesce(suspended_at, now()), suspension_reason = v_reason
   where id = p_project_id;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id, 'project.suspend', 'project', p_project_id::text, jsonb_build_object('reason', v_reason));

  select * into v_backend from public.app_backends where project_id = p_project_id;
  if found and v_backend.status = 'active' then
    perform public.enqueue_job('backend.suspend', jsonb_build_object('appBackendId', v_backend.id, 'reason', 'admin'),
                               p_project_id, 'backend.suspend:' || v_backend.id, now(), 10);
    return 'suspending';
  end if;
  return 'suspended';            -- nothing running; publishing stays blocked
end;
$$;

-- Lifts an admin suspension. The backend comes back only while the owner's plan is paid
-- (the API checks it); otherwise it stays paused until billing resumes it.
create or replace function public.admin_unsuspend_project(p_project_id uuid, p_admin_id uuid, p_note text, p_resume boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_backend public.app_backends%rowtype;
begin
  perform private.assert_admin(p_admin_id);
  update public.projects set suspended_at = null, suspension_reason = null
   where id = p_project_id and suspended_at is not null;
  if not found then
    raise exception 'not_suspended' using errcode = 'P0001';
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id, 'project.unsuspend', 'project', p_project_id::text,
          jsonb_build_object('note', left(coalesce(p_note, ''), 500)));
  select * into v_backend from public.app_backends where project_id = p_project_id;
  if p_resume and found and v_backend.status = 'paused' then
    perform public.enqueue_job('backend.resume', jsonb_build_object('appBackendId', v_backend.id),
                               p_project_id, 'backend.resume:' || v_backend.id, now(), 30);
    return 'resuming';
  end if;
  return 'unsuspended';
end;
$$;

create or replace function public.admin_grant_credits(p_user_id uuid, p_admin_id uuid, p_amount integer, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  perform private.assert_admin(p_admin_id);
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_amount < 0 and (select credits_balance from public.profiles where id = p_user_id) + p_amount < 0 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;
  insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
  values (p_user_id, p_amount, 'adjustment', 'admin:' || gen_random_uuid()::text,
          jsonb_build_object('by', p_admin_id, 'note', left(p_note, 300)));
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id, 'user.credits', 'user', p_user_id::text, jsonb_build_object('amount', p_amount, 'note', left(p_note, 300)));
  select credits_balance into v_balance from public.profiles where id = p_user_id;
  return v_balance;
end;
$$;

-- Public content reports (anyone, no account). Light flood control per app and reporter.
create or replace function public.submit_report(p_project_slug text, p_email text, p_reason text, p_details text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_email text := lower(nullif(btrim(coalesce(p_email, '')), ''));
begin
  select id into v_project from public.projects where slug = p_project_slug;
  if v_project is null then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.reports where project_id = v_project and created_at > now() - interval '1 day') >= 50
     or (v_email is not null and (select count(*) from public.reports
          where project_id = v_project and reporter_email = v_email and created_at > now() - interval '1 day') >= 3) then
    return false;                                                  -- accepted silently, not stored
  end if;
  insert into public.reports (project_id, reporter_email, reason, details)
  values (v_project, v_email, p_reason, left(p_details, 4000));
  return true;
end;
$$;

create or replace function public.admin_handle_report(p_report_id uuid, p_admin_id uuid, p_status public.report_status, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  perform private.assert_admin(p_admin_id);
  if p_status = 'open' then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  update public.reports set status = p_status, handled_by = p_admin_id, handled_at = now()
   where id = p_report_id
  returning project_id into v_project;
  if v_project is null then
    raise exception 'report_not_found' using errcode = 'P0002';
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_admin_id, 'report.' || p_status::text, 'report', p_report_id::text,
          jsonb_build_object('project', v_project, 'note', left(coalesce(p_note, ''), 500)));
end;
$$;

-- Numbers for the admin home page. Aggregates of platform tables only.
create or replace function public.admin_overview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'users',              (select count(*) from public.profiles),
    'paid_subscriptions', (select count(*) from public.subscriptions s join public.plans p on p.id = s.plan_id
                            where s.status in ('active', 'trialing', 'past_due') and p.price_halalas > 0),
    'past_due',           (select count(*) from public.subscriptions where status = 'past_due'),
    'projects',           (select count(*) from public.projects where status <> 'archived'),
    'suspended_projects', (select count(*) from public.projects where suspended_at is not null),
    'backends',           (select jsonb_object_agg(status, n) from (select status, count(*) n from public.app_backends group by status) b),
    'open_reports',       (select count(*) from public.reports where status in ('open', 'reviewing')),
    'pending_charities',  (select count(*) from public.organizations where verification_status = 'pending'),
    'hosting_to_quote',   (select count(*) from public.hosting_requests where status = 'requested'),
    'hosting_to_fulfil',  (select count(*) from public.hosting_requests where status in ('paid', 'migrating')),
    'revenue_30d_halalas',(select coalesce(sum(amount_halalas), 0) from public.payments
                            where status = 'paid' and updated_at > now() - interval '30 days'),
    'jobs',               (select jsonb_object_agg(status, n) from (select status, count(*) n from public.jobs
                            where status in ('queued', 'running') or updated_at > now() - interval '1 day' group by status) j),
    'credits_spent_30d',  (select coalesce(-sum(amount), 0) from public.credit_transactions
                            where reason = 'generation' and created_at > now() - interval '30 days')
  );
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'private.assert_admin(uuid)',
    'public.admin_suspend_project(uuid, uuid, text)',
    'public.admin_unsuspend_project(uuid, uuid, text, boolean)',
    'public.admin_grant_credits(uuid, uuid, integer, text)',
    'public.submit_report(text, text, text, text)',
    'public.admin_handle_report(uuid, uuid, public.report_status, text)',
    'public.admin_overview()'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============ 20261121210000_account_deletion.sql ============
-- T-17: a platform customer deletes their account (UC-13, design §5.9).
-- Request: billing stops at once and the purge is scheduled 7 days later (the owner
-- can cancel until then). Purge (worker job account.purge): every app backend is
-- destroyed, web projects removed, stored files and Vault secrets deleted, then the
-- auth user is deleted, which cascades to all platform rows. Done within 30 days.
-- Payment records are kept without the user (tax law), with the person removed.

alter table public.profiles
  add column deletion_requested_at   timestamptz,
  add column deletion_scheduled_for  timestamptz;

-- keep invoices/payments after the person is gone (VAT records), detached from them
alter table public.payments alter column user_id drop not null;
alter table public.payments drop constraint if exists payments_user_id_fkey;
alter table public.payments add constraint payments_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete set null;

create or replace function public.request_account_deletion(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_when timestamptz;
begin
  update public.profiles
     set deletion_requested_at = coalesce(deletion_requested_at, now()),
         deletion_scheduled_for = coalesce(deletion_scheduled_for, now() + interval '7 days')
   where id = p_user_id
  returning deletion_scheduled_for into v_when;
  if v_when is null then
    raise exception 'user_not_found' using errcode = 'P0002';
  end if;

  -- no more charges: the paid period runs out, the saved card is forgotten
  update public.subscriptions
     set cancel_at_period_end = true, next_charge_at = null, moyasar_token_id = null
   where user_id = p_user_id and status in ('trialing', 'active', 'past_due');
  -- open requests that would charge later
  update public.hosting_requests hr set status = 'canceled'
    from public.projects p
   where p.id = hr.project_id and p.owner_id = p_user_id and hr.status in ('requested', 'quoted');

  perform public.enqueue_job('account.purge', jsonb_build_object('userId', p_user_id), null,
                             'account.purge:' || p_user_id, v_when, 20);
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'account.delete_request', 'user', p_user_id::text, jsonb_build_object('scheduled_for', v_when));
  return v_when;
end;
$$;

create or replace function public.cancel_account_deletion(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set deletion_requested_at = null, deletion_scheduled_for = null
   where id = p_user_id and deletion_scheduled_for > now();
  if not found then
    raise exception 'not_cancelable' using errcode = 'P0001';
  end if;
  delete from public.jobs where dedupe_key = 'account.purge:' || p_user_id and status = 'queued';
  insert into public.audit_log (actor_id, action, target_type, target_id)
  values (p_user_id, 'account.delete_cancel', 'user', p_user_id::text);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.request_account_deletion(uuid)', 'public.cancel_account_deletion(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;


-- ============ 20261121220000_pricing_cr004.sql ============
-- CR-004 (approved by مصعب 2026-11-21): prices must cover every platform fee.
-- See docs/spec/pricing-cost-check.md.
--   * basic 149 SAR (1 app, 100 credits), pro 299 SAR (2 apps, 200 credits)
--   * extra published app: 129 SAR a month, added to the monthly renewal
--   * charity discount 20% (about cost), 20 signup credits
--   * the number of published apps is now enforced (BUG-004)
-- Credits are metered on actual AI cost in the application layer (hold, then settle).

alter type public.payment_purpose add value if not exists 'extra_app';

-- -----------------------------------------------------------------------------
-- Prices
-- -----------------------------------------------------------------------------
update public.plans set price_halalas = 14900, monthly_credits = 100, max_published_apps = 1, charity_discount_pct = 20
 where code = 'basic';
update public.plans set price_halalas = 29900, monthly_credits = 200, max_published_apps = 2, charity_discount_pct = 20
 where code = 'pro';

insert into public.plans (code, name_ar, name_en, price_halalas, billing_interval, monthly_credits, max_published_apps, features, charity_discount_pct, sort_order)
values ('extra_app', 'تطبيق منشور إضافي', 'Extra published app', 12900, null, 0, 1, '{"addon":"extra_app"}', 20, 5)
on conflict (code) do update
  set price_halalas = excluded.price_halalas, features = excluded.features,
      charity_discount_pct = excluded.charity_discount_pct, max_published_apps = excluded.max_published_apps;

-- -----------------------------------------------------------------------------
-- Signup credits: 20 (enough for one spec and one first build in preview)
-- -----------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_signup_credits constant integer := 20;   -- CR-004
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

-- -----------------------------------------------------------------------------
-- Published-app slots
-- -----------------------------------------------------------------------------
alter table public.subscriptions
  add column extra_apps integer not null default 0 check (extra_apps between 0 and 50);

alter table public.projects
  add column published_at timestamptz;   -- set when the app first takes a published slot

-- The user's live paid subscription (same rule as isPaidSubscription in packages/backends/ensure.ts).
create or replace function private.live_subscription(p_user_id uuid)
returns public.subscriptions
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
   where s.user_id = p_user_id
     and p.price_halalas > 0
     and ((s.status in ('active', 'trialing') and (s.current_period_end is null or s.current_period_end > now()))
          or (s.status = 'past_due' and s.grace_until > now()))
   order by s.current_period_end desc nulls first
   limit 1;
$$;

create or replace function public.publish_limit_for(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.max_published_apps + s.extra_apps
                     from private.live_subscription(p_user_id) s
                     join public.plans p on p.id = s.plan_id
                    where s.id is not null), 0);
$$;

create or replace function public.published_app_count(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.projects
   where owner_id = p_user_id and published_at is not null and status <> 'archived';
$$;

-- Called before any production deploy or store build. Idempotent per project.
create or replace function public.claim_publish_slot(p_project_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.projects%rowtype;
begin
  -- serialize claims of the same owner
  perform 1 from public.profiles where id = p_user_id for update;

  select * into v_project from public.projects where id = p_project_id;
  if not found or v_project.owner_id <> p_user_id then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if v_project.published_at is not null then
    return 'already_published';
  end if;
  if public.published_app_count(p_user_id) >= public.publish_limit_for(p_user_id) then
    raise exception 'app_limit_reached' using errcode = 'P0001';
  end if;

  update public.projects set published_at = now() where id = p_project_id;
  return 'claimed';
end;
$$;

-- -----------------------------------------------------------------------------
-- Extra-app add-on: bought one at a time (full month, no proration), renewed with the plan.
-- -----------------------------------------------------------------------------
create or replace function public.addon_monthly_for(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.extra_apps * public.plan_price_for(p_user_id, (select id from public.plans where code = 'extra_app'))
                     from private.live_subscription(p_user_id) s
                    where s.id is not null), 0)::int;
$$;

create or replace function public.remove_extra_app(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.subscriptions%rowtype;
begin
  perform 1 from public.profiles where id = p_user_id for update;
  select * into v_sub from private.live_subscription(p_user_id);
  if v_sub.id is null or v_sub.extra_apps = 0 then
    raise exception 'no_extra_app' using errcode = 'P0001';
  end if;
  if public.published_app_count(p_user_id) > public.publish_limit_for(p_user_id) - 1 then
    raise exception 'apps_over_limit' using errcode = 'P0001';
  end if;
  update public.subscriptions set extra_apps = extra_apps - 1 where id = v_sub.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'billing.extra_app_removed', 'subscription', v_sub.id::text, '{}'::jsonb);
  return v_sub.extra_apps - 1;
end;
$$;

create or replace function public.due_renewals(p_limit integer default 50)
returns table (subscription_id uuid, user_id uuid, plan_id uuid, token text, amount integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.user_id, s.plan_id, s.moyasar_token_id,
         public.plan_price_for(s.user_id, s.plan_id) + public.hosting_monthly_for(s.user_id) + public.addon_monthly_for(s.user_id)
    from public.subscriptions s
   where s.status in ('active', 'trialing')
     and s.provider = 'moyasar'
     and s.next_charge_at is not null and s.next_charge_at <= now()
     and not s.cancel_at_period_end
     and s.moyasar_token_id is not null and s.plan_id is not null
   order by s.next_charge_at
   limit p_limit;
$$;

-- -----------------------------------------------------------------------------
-- settle_platform_payment: same as T-10, plus the extra_app purpose.
-- -----------------------------------------------------------------------------
create or replace function public.settle_platform_payment(
  p_payment_id          uuid,
  p_provider_payment_id text,
  p_amount              integer,
  p_token               text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pay   public.payments%rowtype;
  v_plan  public.plans%rowtype;
  v_sub   public.subscriptions%rowtype;
  v_start timestamptz;
begin
  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment_not_found' using errcode = 'P0002';
  end if;
  if v_pay.status = 'paid' then
    return 'already_settled';
  end if;
  if v_pay.status <> 'initiated' then
    raise exception 'payment_not_open' using errcode = 'P0001';
  end if;
  if p_amount is distinct from v_pay.amount_halalas then
    update public.payments set status = 'failed', failure_reason = 'amount_mismatch', provider_payment_id = p_provider_payment_id
     where id = p_payment_id;
    return 'amount_mismatch';
  end if;

  update public.payments set status = 'paid', provider_payment_id = p_provider_payment_id where id = p_payment_id;

  if v_pay.purpose = 'credits' then
    select * into v_plan from public.plans where id = v_pay.plan_id;
    insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
    values (v_pay.user_id, v_plan.monthly_credits, 'purchase', p_payment_id::text, jsonb_build_object('plan', v_plan.code));
    return 'credits_added';
  end if;

  if v_pay.purpose = 'extra_app' then
    select * into v_sub from private.live_subscription(v_pay.user_id);
    if v_sub.id is null then
      -- paid after the plan lapsed: keep the money traceable for a manual refund
      update public.payments set failure_reason = 'no_live_subscription' where id = p_payment_id;
      return 'extra_app_orphaned';
    end if;
    update public.subscriptions set extra_apps = extra_apps + 1 where id = v_sub.id;
    return 'extra_app_added';
  end if;

  if v_pay.purpose = 'subscription' then
    select * into v_plan from public.plans where id = v_pay.plan_id;
    select * into v_sub from public.subscriptions
     where user_id = v_pay.user_id and status in ('trialing', 'active', 'past_due') for update;

    -- a renewal continues from the end of the paid period; a new plan starts now
    v_start := case when found and v_sub.plan_id = v_plan.id and v_sub.current_period_end > now()
                    then v_sub.current_period_end else now() end;

    if found then
      update public.subscriptions
         set plan_id = v_plan.id,
             plan = case when v_plan.code = 'pro' then 'pro'::public.plan_tier else 'starter'::public.plan_tier end,
             status = 'active',
             includes_store_publishing = coalesce((v_plan.features ->> 'stores')::boolean, false),
             monthly_credits = v_plan.monthly_credits,
             current_period_start = v_start,
             current_period_end = v_start + interval '1 month',
             next_charge_at = v_start + interval '1 month',
             moyasar_token_id = coalesce(p_token, v_sub.moyasar_token_id),
             failed_attempts = 0,
             grace_until = null,
             cancel_at_period_end = false
       where id = v_sub.id;
    else
      insert into public.subscriptions (user_id, provider, plan, plan_id, status, billing_interval,
                                        includes_store_publishing, monthly_credits,
                                        current_period_start, current_period_end, next_charge_at, moyasar_token_id)
      values (v_pay.user_id, 'moyasar',
              case when v_plan.code = 'pro' then 'pro'::public.plan_tier else 'starter'::public.plan_tier end,
              v_plan.id, 'active', 'month',
              coalesce((v_plan.features ->> 'stores')::boolean, false), v_plan.monthly_credits,
              v_start, v_start + interval '1 month', v_start + interval '1 month', p_token);
    end if;

    insert into public.credit_transactions (user_id, amount, reason, reference_id, metadata)
    select v_pay.user_id, v_plan.monthly_credits, 'subscription_grant', p_payment_id::text, jsonb_build_object('plan', v_plan.code)
     where v_plan.monthly_credits > 0;
    return 'subscription_active';
  end if;

  if v_pay.purpose = 'hosting_setup' then
    update public.hosting_requests set status = 'paid', setup_payment_id = p_payment_id
     where id = v_pay.reference_id and status in ('requested', 'quoted');
    return 'hosting_paid';
  end if;

  return 'paid';
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'private.live_subscription(uuid)',
    'public.publish_limit_for(uuid)',
    'public.published_app_count(uuid)',
    'public.claim_publish_slot(uuid, uuid)',
    'public.addon_monthly_for(uuid)',
    'public.remove_extra_app(uuid)',
    'public.due_renewals(integer)',
    'public.settle_platform_payment(uuid, text, integer, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Apps already published before this migration keep their slot.
update public.projects p set published_at = coalesce(p.published_at, now())
 where exists (select 1 from public.app_backends b where b.project_id = p.id and b.status not in ('deleting', 'deleted'))
    or exists (select 1 from public.web_deployments d where d.project_id = p.id and d.target = 'production');

