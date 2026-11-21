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
