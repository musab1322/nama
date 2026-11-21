-- T-10 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

-- charity discount only for a verified charity
select public.plan_price_for('aaaaaaaa-0000-0000-0000-000000000001', (select id from plans where code='basic')) as price_business;  -- 9900
insert into organizations (owner_id, kind, legal_name, license_number, verification_status) values ('bbbbbbbb-0000-0000-0000-000000000002','charity','جمعية','77','verified');
select public.plan_price_for('bbbbbbbb-0000-0000-0000-000000000002', (select id from plans where code='basic')) as price_charity;   -- 4950

-- subscription payment
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),9900);
select public.settle_platform_payment('11111111-0000-0000-0000-000000000001','pay_1', 100, null) as wrong_amount;     -- amount_mismatch
select status, failure_reason from payments where id='11111111-0000-0000-0000-000000000001';                         -- failed
select public.settle_platform_payment('11111111-0000-0000-0000-000000000001','pay_1', 9900, null);                  -- EXPECT payment_not_open
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),9900);
select public.settle_platform_payment('11111111-0000-0000-0000-000000000002','pay_2', 9900, 'token_abc') as first;   -- subscription_active
select public.settle_platform_payment('11111111-0000-0000-0000-000000000002','pay_2', 9900, 'token_abc') as replay;  -- already_settled
select status, plan, includes_store_publishing, moyasar_token_id, failed_attempts from subscriptions;                 -- active starter t token_abc 0
select credits_balance from profiles where id='aaaaaaaa-0000-0000-0000-000000000001';                                -- 100 (+ signup bonus if any)

-- renewal continues from the period end
update subscriptions set next_charge_at = now() - interval '1 minute';
select count(*) as due, min(amount) as amount from public.due_renewals(10);                                           -- 1, 9900
insert into payments (id, user_id, purpose, plan_id, amount_halalas, reference_id, metadata) values
  ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),9900,
   (select id from subscriptions), jsonb_build_object('period_end', (select current_period_end from subscriptions)::text));
insert into payments (user_id, purpose, plan_id, amount_halalas, reference_id, metadata) values
  ('aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),9900,
   (select id from subscriptions), jsonb_build_object('period_end', (select current_period_end from subscriptions)::text)); -- EXPECT one renewal per period
select (select current_period_end from subscriptions) as old_end \gset
select public.settle_platform_payment('11111111-0000-0000-0000-000000000003','pay_3', 9900, null);
select current_period_start = :'old_end'::timestamptz as continues, moyasar_token_id from subscriptions;              -- t token_abc

-- failures: retry, retry, grace, expire
select public.record_renewal_failure((select id from subscriptions), 'card declined') as f1;   -- retry_scheduled
select public.record_renewal_failure((select id from subscriptions), 'card declined') as f2;   -- retry_scheduled
select public.record_renewal_failure((select id from subscriptions), 'card declined') as f3;   -- grace_started
select status, grace_until > now() + interval '13 days' as grace_14d from subscriptions;       -- past_due t
select count(*) as expired_now from public.expire_lapsed_subscriptions();                       -- 0
update subscriptions set grace_until = now() - interval '1 second';
select count(*) as expired_after from public.expire_lapsed_subscriptions();                     -- 1
select status from subscriptions;                                                               -- expired

-- credit pack
insert into payments (id, user_id, purpose, plan_id, amount_halalas) values
  ('11111111-0000-0000-0000-000000000004','bbbbbbbb-0000-0000-0000-000000000002','credits',(select id from plans where code='credits_50'),4900);
select public.settle_platform_payment('11111111-0000-0000-0000-000000000004','pay_4', 4900, null) as pack;   -- credits_added
select credits_balance >= 50 as pack_credited from profiles where id='bbbbbbbb-0000-0000-0000-000000000002';
reset role;

set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select public.settle_platform_payment('11111111-0000-0000-0000-000000000004','x', 4900, null);   -- EXPECT denied
select count(*) as own_payments from payments;                                                  -- 3
reset role;

-- T-11: the pending secret id is never visible to users
set role service_role;
insert into projects (owner_id,name,slug) values ('aaaaaaaa-0000-0000-0000-000000000001','Shop','shop-pay');
insert into app_payment_accounts (project_id, publishable_key, pending_secret_id, key_mode) select id, 'pk_test_abc', gen_random_uuid(), 'test' from projects where slug='shop-pay';
reset role;
set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
select publishable_key, key_mode from app_payment_accounts;                    -- pk_test_abc test
select pending_secret_id from app_payment_accounts;                            -- EXPECT denied (column)
reset role;
