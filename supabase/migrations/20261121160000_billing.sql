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
