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
