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
