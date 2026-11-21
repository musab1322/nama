-- Platform base for every generated app (platform-owned; the AI cannot edit files under supabase/).
-- Runs first, on the app's own database and in the browser preview (PGlite).

-- Privacy notice consent (PDPL; FR-011). One row per accepted notice version.
create table if not exists public.privacy_consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  notice_version text not null check (char_length(notice_version) between 1 and 40),
  accepted_at timestamptz not null default now(),
  unique (user_id, notice_version)
);
alter table public.privacy_consents enable row level security;
create policy "privacy_consents: own rows" on public.privacy_consents for select to authenticated
  using (user_id = (select auth.uid()));
create policy "privacy_consents: accept for self" on public.privacy_consents for insert to authenticated
  with check (user_id = (select auth.uid()));
grant select, insert on public.privacy_consents to authenticated;

-- Payments through the app owner's own Moyasar account (FR-014). Written only by the
-- payments function with the secret key; users read their own.
create table if not exists public.app_payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users (id) on delete set null,
  reference_type  text not null check (reference_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  reference_id    text not null check (char_length(reference_id) <= 100),
  amount_halalas  integer not null check (amount_halalas >= 100),
  currency        text not null default 'SAR',
  status          text not null default 'initiated' check (status in ('initiated', 'paid', 'failed', 'expired', 'refunded')),
  provider_ref    text,             -- Moyasar invoice id
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists app_payments_reference_idx on public.app_payments (reference_type, reference_id);
alter table public.app_payments enable row level security;
create policy "app_payments: own rows" on public.app_payments for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.app_payments to authenticated;

-- The price is always computed in the database, never taken from the app.
-- Each app replaces this with its own pricing (e.g. the total of an order's items) and
-- raises when p_user_id may not pay for that reference (e.g. someone else's order).
create or replace function public.payment_amount_for(p_reference_type text, p_reference_id text, p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  raise exception 'payments are not configured for %', p_reference_type using errcode = 'P0001';
end;
$$;

-- Called once when a payment is confirmed (e.g. mark the order as paid). Default: nothing.
create or replace function public.on_payment_paid(p_reference_type text, p_reference_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  return;
end;
$$;

revoke all on function public.payment_amount_for(text, text, uuid) from public, anon, authenticated;
revoke all on function public.on_payment_paid(text, text) from public, anon, authenticated;
grant execute on function public.payment_amount_for(text, text, uuid) to service_role;
grant execute on function public.on_payment_paid(text, text) to service_role;
