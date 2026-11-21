-- T-14 tests. Lines marked EXPECT must fail; every other statement must succeed.
\set VERBOSITY terse
insert into auth.users (id,email) values ('aaaaaaaa-0000-0000-0000-000000000001','a@x.com'),('bbbbbbbb-0000-0000-0000-000000000002','b@x.com'),('cccccccc-0000-0000-0000-000000000003','admin@x.com');
update profiles set role = 'admin' where id = 'cccccccc-0000-0000-0000-000000000003';
insert into projects (owner_id, name, slug) values ('aaaaaaaa-0000-0000-0000-000000000001','App','sa-app');
set role service_role; set request.jwt.claims = '{"role":"service_role"}';

select public.request_saudi_hosting((select id from projects), 'bbbbbbbb-0000-0000-0000-000000000002');   -- EXPECT project_not_found
select public.request_saudi_hosting((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001') = public.request_saudi_hosting((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001') as same_request; -- t
select * from public.open_hosting_payment((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001');            -- EXPECT not_payable
select public.quote_hosting_request((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001', 50000, 20000, null); -- EXPECT forbidden
select public.quote_hosting_request((select id from hosting_requests), 'cccccccc-0000-0000-0000-000000000003', 50, 20000, null);    -- EXPECT invalid_quote
select public.quote_hosting_request((select id from hosting_requests), 'cccccccc-0000-0000-0000-000000000003', 50000, 20000, 'first cell: 5 business days');
select * from public.open_hosting_payment((select id from hosting_requests), 'bbbbbbbb-0000-0000-0000-000000000002');            -- EXPECT request_not_found
select amount from public.open_hosting_payment((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001');       -- 50000
select (select payment_id from public.open_hosting_payment((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001')) = (select id from payments) as reused; -- t

-- a new quote voids the open payment
select public.quote_hosting_request((select id from hosting_requests), 'cccccccc-0000-0000-0000-000000000003', 40000, 20000, null);
select status, failure_reason from payments;                                                     -- failed quote_changed
select amount from public.open_hosting_payment((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001');       -- 40000
select public.settle_platform_payment((select id from payments where status='initiated'), 'pay_h1', 40000, null) as settled;     -- hosting_paid
select status from hosting_requests;                                                             -- paid
select public.cancel_hosting_request((select id from hosting_requests), 'aaaaaaaa-0000-0000-0000-000000000001');                 -- EXPECT not_cancelable

-- monthly fee joins the renewal once active
insert into subscriptions (user_id, provider, plan, plan_id, status, billing_interval, current_period_start, current_period_end, next_charge_at, moyasar_token_id)
values ('aaaaaaaa-0000-0000-0000-000000000001','moyasar','starter',(select id from plans where code='basic'),'active','month', now() - interval '1 month', now(), now() - interval '1 minute','tok');
select amount from public.due_renewals(10);                                                      -- 9900
update hosting_requests set status = 'active';
select amount from public.due_renewals(10);                                                      -- 29900
select public.request_saudi_hosting((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001');                          -- EXPECT already_saudi
select array_agg(action order by id) from audit_log where action like 'hosting.%';              -- {hosting.request,hosting.quote,hosting.quote}

set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}';
select public.request_saudi_hosting((select id from projects), 'aaaaaaaa-0000-0000-0000-000000000001');                          -- EXPECT denied
select status, setup_fee_halalas, monthly_fee_halalas from hosting_requests;                    -- active 40000 20000 (reads own)
