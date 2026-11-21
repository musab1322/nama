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
