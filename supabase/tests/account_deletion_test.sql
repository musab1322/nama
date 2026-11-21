-- T-17 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com');
insert into projects (owner_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001','App','del-app');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';
insert into subscriptions (user_id, provider, plan, plan_id, status, billing_interval, current_period_start, current_period_end, next_charge_at, moyasar_token_id)
values ('aaaaaaaa-0000-0000-0000-000000000001','moyasar','starter',(select id from plans where code='basic'),'active','month', now(), now() + interval '1 month', now() + interval '1 month','tok');
insert into payments (user_id, purpose, plan_id, amount_halalas, status) values ('aaaaaaaa-0000-0000-0000-000000000001','subscription',(select id from plans where code='basic'),9900,'paid');

select public.request_account_deletion('aaaaaaaa-0000-0000-0000-000000000001') > now() + interval '6 days' as scheduled;   -- t
select cancel_at_period_end, next_charge_at, moyasar_token_id from subscriptions;                                      -- t null null
select kind, run_after > now() as later from jobs;                                                                     -- account.purge t
select public.request_account_deletion('aaaaaaaa-0000-0000-0000-000000000001') is not null as again;                   -- t (same date, one job)
select count(*) as jobs from jobs;                                                                                     -- 1
select public.cancel_account_deletion('aaaaaaaa-0000-0000-0000-000000000001');
select count(*) as jobs_after_cancel, (select deletion_scheduled_for from profiles) as scheduled from jobs;           -- 0 null
select public.cancel_account_deletion('aaaaaaaa-0000-0000-0000-000000000001');                                         -- EXPECT not_cancelable

-- purge end state: deleting the auth user keeps the payment, without the person
reset role;
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select count(*) as profiles, (select count(*) from projects) as projects, (select count(*) from payments where user_id is null) as kept_payments from profiles; -- 0 0 1
