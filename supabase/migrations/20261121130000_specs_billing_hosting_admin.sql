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
