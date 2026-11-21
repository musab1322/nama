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
